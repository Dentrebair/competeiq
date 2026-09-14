import { Pool } from "pg";

import { requireEnv } from "@/lib/env";
import { databaseConnection } from "@/lib/queue/connection";
import type { AlertRow, BaselineEntry, BaselineRow } from "@/lib/pipeline/signal-evaluation";
import type { BaselineHistoryRow } from "@/lib/pipeline/baseline-history";

/**
 * The worker's own connection to Postgres, as the scoped `pipeline_worker`
 * role (supabase/07-pipeline-worker.sql). Separate pool from the one
 * worker/worker.ts opens for pg-boss/heartbeat — handlers are not handed that
 * pool today, and a lazy singleton here is simpler than threading one through.
 */
let pool: Pool | null = null;

export function getPipelineDb(): Pool {
  pool ??= new Pool({
    ...databaseConnection(requireEnv("PIPELINE_WORKER_DATABASE_URL")),
    application_name: "competeiq-worker-handlers",
    max: 4,
  });
  return pool;
}

export interface CompetitorRow {
  id: string;
  name: string;
}

/** `pipeline_worker` has select on competitors (07, PART 4). */
export async function getCompetitor(competitorId: string): Promise<CompetitorRow | null> {
  const db = getPipelineDb();
  const { rows } = await db.query<CompetitorRow>(
    `select id, name from public.competitors where id = $1`,
    [competitorId],
  );
  return rows[0] ?? null;
}

export interface ScrapeTargetRow {
  id: string;
  name: string;
  url: string;
}

/** What start_scrape needs to build the Actor input: the URL to scrape. */
export async function getScrapeTarget(competitorId: string): Promise<ScrapeTargetRow | null> {
  const db = getPipelineDb();
  const { rows } = await db.query<ScrapeTargetRow>(
    `select id, name, url from public.competitors where id = $1 and active`,
    [competitorId],
  );
  return rows[0] ?? null;
}

/**
 * The competitor a run belongs to, from the worker's own record (08, written
 * by start_scrape when it started the run) — never from the webhook body
 * (ADR-0005).
 */
export async function getCompetitorForRun(runId: string): Promise<CompetitorRow | null> {
  const db = getPipelineDb();
  const { rows } = await db.query<CompetitorRow>(
    `select c.id, c.name
       from public.scrape_runs sr
       join public.competitors c on c.id = sr.competitor_id
      where sr.run_id = $1`,
    [runId],
  );
  return rows[0] ?? null;
}

/** Written by start_scrape the moment it starts an Apify run. */
export async function recordScrapeRun(runId: string, competitorId: string): Promise<void> {
  const db = getPipelineDb();
  await db.query(
    `insert into public.scrape_runs (run_id, competitor_id) values ($1, $2)
     on conflict (run_id) do nothing`,
    [runId, competitorId],
  );
}

/** The Baseline as it stood before this run. Empty means the competitor's first run. */
export async function getBaseline(competitorId: string): Promise<BaselineEntry[]> {
  const db = getPipelineDb();
  const { rows } = await db.query<BaselineEntry>(
    `select product_handle, last_price
       from public.competitor_products
      where competitor_id = $1`,
    [competitorId],
  );
  return rows;
}

export interface PersistRunParams {
  runId: string;
  competitorId: string;
  alerts: AlertRow[];
  baseline: BaselineRow[];
  baselineHistory: BaselineHistoryRow[];
}

/**
 * One transaction: Alerts, Baseline, Baseline History, and clearing the
 * signal configs' error for this run (ADR: an Alert and its Baseline update
 * must commit together, or partial processing corrupts later diffs).
 *
 * Idempotent: a duplicate run (late webhook after the delayed check already
 * processed it) hits the `dedupe_key` unique index and inserts nothing new.
 * The Baseline upsert is naturally idempotent — writing the same values twice
 * is a no-op in effect. Baseline History is NOT deduped by design: a genuine
 * second processing of the same run would double-record it, but the
 * `process_apify_run` queue policy (`exclusive`) and singletonKey on runId
 * are what actually prevent that, not this function.
 */
export async function persistProcessedRun({
  runId,
  competitorId,
  alerts,
  baseline,
  baselineHistory,
}: PersistRunParams): Promise<void> {
  const db = getPipelineDb();
  const client = await db.connect();

  try {
    await client.query("begin");

    for (const alert of alerts) {
      await client.query(
        `insert into public.alerts (
           workflow, competitor_id, competitor_name, signal_type, severity,
           summary, impact, recommended_action, product_title, product_handle,
           product_url, currency, previous_price, current_price, delta_pct,
           ai_available, dedupe_key
         ) values (
           'worker', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
         )
         on conflict (dedupe_key) do nothing`,
        [
          alert.competitor_id,
          alert.competitor_name,
          alert.signal_type,
          alert.severity,
          alert.summary,
          alert.impact,
          alert.recommended_action,
          alert.product_title,
          alert.product_handle,
          alert.product_url,
          alert.currency,
          alert.previous_price,
          alert.current_price,
          alert.delta_pct,
          alert.ai_available,
          alert.dedupe_key,
        ],
      );
    }

    for (const row of baseline) {
      await client.query(
        `insert into public.competitor_products (
           competitor_id, product_handle, product_title, product_url, currency,
           last_price, last_seen_at
         ) values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (competitor_id, product_handle) do update set
           product_title = excluded.product_title,
           product_url   = excluded.product_url,
           currency      = excluded.currency,
           last_price    = excluded.last_price,
           last_seen_at  = excluded.last_seen_at`,
        [
          row.competitor_id,
          row.product_handle,
          row.product_title,
          row.product_url,
          row.currency,
          row.last_price,
          row.last_seen_at,
        ],
      );
    }

    for (const row of baselineHistory) {
      await client.query(
        `insert into public.baseline_history (
           run_id, competitor_id, product_handle, was_new, previous_price, current_price
         ) values ($1, $2, $3, $4, $5, $6)`,
        [
          row.run_id,
          row.competitor_id,
          row.product_handle,
          row.was_new,
          row.previous_price,
          row.current_price,
        ],
      );
    }

    // Every enabled signal for this competitor was covered by one scrape.
    await client.query(
      `update public.signal_configs
          set last_run_at = now(), last_error = null
        where competitor_id = $1`,
      [competitorId],
    );

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** Written on a failed run so the operator sees why a competitor went quiet. */
export async function recordRunError(competitorId: string, message: string): Promise<void> {
  const db = getPipelineDb();
  await db.query(
    `update public.signal_configs set last_error = $2 where competitor_id = $1`,
    [competitorId, message],
  );
}
