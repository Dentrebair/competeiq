import { Pool } from "pg";

import { requireEnv } from "@/lib/env";
import { databaseConnection } from "@/lib/queue/connection";
import type { AlertRow, BaselineEntry, BaselineRow } from "@/lib/pipeline/signal-evaluation";
import type { BaselineHistoryRow } from "@/lib/pipeline/baseline-history";
import type { DigestAlertInput, BrandProfileInput } from "@/lib/pipeline/digest-request";
import type { ClaudeUsage, DigestPattern, PriorityAction } from "@/lib/types/database";

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

export interface CompetitorForRunRow extends CompetitorRow {
  /** null means no restriction — evaluate every live signal, as before this column existed. */
  requestedSignals: string[] | null;
}

/**
 * The competitor a run belongs to, from the worker's own record (08, written
 * by start_scrape when it started the run) — never from the webhook body
 * (ADR-0005). Also carries the signal selection Run Now's picker made for
 * this run (supabase/16), for the same reason: it has to survive until this
 * exact lookup, since the webhook payload that triggers it carries nothing
 * but the run ID.
 */
export async function getCompetitorForRun(runId: string): Promise<CompetitorForRunRow | null> {
  const db = getPipelineDb();
  const { rows } = await db.query<CompetitorRow & { requested_signals: string[] | null }>(
    `select c.id, c.name, sr.requested_signals
       from public.scrape_runs sr
       join public.competitors c on c.id = sr.competitor_id
      where sr.run_id = $1`,
    [runId],
  );
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, name: row.name, requestedSignals: row.requested_signals };
}

/** Written by start_scrape the moment it starts an Apify run. */
export async function recordScrapeRun(
  runId: string,
  competitorId: string,
  requestedSignals?: string[],
): Promise<void> {
  const db = getPipelineDb();
  await db.query(
    `insert into public.scrape_runs (run_id, competitor_id, requested_signals) values ($1, $2, $3)
     on conflict (run_id) do nothing`,
    [runId, competitorId, requestedSignals ?? null],
  );
}

export type ScrapeRunStatus = "running" | "processing" | "succeeded" | "failed";

/**
 * Progress the run's status so the UI (Realtime on scrape_runs) can show what
 * "Run Now" is doing. `error` is only meaningful for 'failed' — cleared
 * otherwise so a retry's success doesn't leave a stale message behind.
 */
export async function updateScrapeRunStatus(
  runId: string,
  status: ScrapeRunStatus,
  error?: string,
): Promise<void> {
  const db = getPipelineDb();
  await db.query(
    `update public.scrape_runs set status = $2, error = $3, updated_at = now() where run_id = $1`,
    [runId, status, error ?? null],
  );
}

/** The Baseline as it stood before this run. Empty means the competitor's first run. */
export async function getBaseline(competitorId: string): Promise<BaselineEntry[]> {
  const db = getPipelineDb();
  const { rows } = await db.query<BaselineEntry>(
    `select product_handle, last_price, last_in_stock
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
           last_price, last_in_stock, last_seen_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (competitor_id, product_handle) do update set
           product_title  = excluded.product_title,
           product_url    = excluded.product_url,
           currency       = excluded.currency,
           last_price     = excluded.last_price,
           last_in_stock  = excluded.last_in_stock,
           last_seen_at   = excluded.last_seen_at`,
        [
          row.competitor_id,
          row.product_handle,
          row.product_title,
          row.product_url,
          row.currency,
          row.last_price,
          row.last_in_stock,
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

export interface DigestLockRow {
  id: string;
}

/** The lock row the app's requestDigest() already inserted. Null if it's not (or no longer) 'generating'. */
export async function getDigestLock(digestId: string): Promise<DigestLockRow | null> {
  const db = getPipelineDb();
  const { rows } = await db.query<DigestLockRow>(
    `select id from public.digests where id = $1 and status = 'generating'`,
    [digestId],
  );
  return rows[0] ?? null;
}

/** Every unread alert — WF-03 never filtered by a time window either (docs/n8n-claude-calls.md § 2). */
export async function getUnreadAlertsForDigest(): Promise<DigestAlertInput[]> {
  const db = getPipelineDb();
  const { rows } = await db.query<DigestAlertInput>(
    `select id, competitor_name, signal_type, severity, summary, impact, recommended_action, created_at
       from public.alerts
      where is_read = false
      order by created_at desc`,
  );
  return rows;
}

/** All monitored competitors, not just the ones with alerts — quiet_competitors needs the full roster. */
export async function getActiveCompetitorNames(): Promise<string[]> {
  const db = getPipelineDb();
  const { rows } = await db.query<{ name: string }>(
    `select name from public.competitors where active order by name`,
  );
  return rows.map((row) => row.name);
}

/** Null until onboarding has run — the digest degrades to generalising, same as WF-02/WF-03 did. */
export async function getBrandProfileForDigest(): Promise<BrandProfileInput | null> {
  const db = getPipelineDb();
  const { rows } = await db.query<BrandProfileInput>(
    `select url, name, categories, price_min, price_max, currency, positioning, priorities, catalogue_source
       from public.brand_profile
      limit 1`,
  );
  return rows[0] ?? null;
}

/**
 * Where the previous digest's window ended, so consecutive digests don't gap
 * or overlap in their reported period. Null on the first digest ever.
 */
export async function getLastReadyDigestPeriodEnd(): Promise<Date | null> {
  const db = getPipelineDb();
  const { rows } = await db.query<{ period_end: string | null }>(
    `select period_end from public.digests
      where status = 'ready' and period_end is not null
      order by generated_at desc nulls last
      limit 1`,
  );
  return rows[0]?.period_end ? new Date(rows[0].period_end) : null;
}

export interface WriteDigestReadyParams {
  digestId: string;
  headline: string;
  priorityAction: PriorityAction;
  patterns: DigestPattern[];
  quietCompetitors: string[];
  alertIds: number[];
  periodStart: Date;
  periodEnd: Date;
  claudeUsage: ClaudeUsage;
}

/** `where status = 'generating'` matches WF-03's own PATCH — updates the lock row, never inserts a new one. */
export async function writeDigestReady(params: WriteDigestReadyParams): Promise<void> {
  const db = getPipelineDb();
  await db.query(
    `update public.digests set
       status = 'ready',
       headline = $2,
       priority_action = $3,
       patterns = $4,
       quiet_competitors = $5,
       alert_ids = $6,
       alert_count = $7,
       period_start = $8,
       period_end = $9,
       claude_usage = $10,
       generated_at = now()
     where id = $1 and status = 'generating'`,
    [
      params.digestId,
      params.headline,
      JSON.stringify(params.priorityAction),
      JSON.stringify(params.patterns),
      params.quietCompetitors,
      params.alertIds,
      params.alertIds.length,
      params.periodStart.toISOString(),
      params.periodEnd.toISOString(),
      JSON.stringify(params.claudeUsage),
    ],
  );
}

/**
 * Terminal, not retried (mirrors WF-03: "still PATCH the row — set
 * status='failed'... leaving it at 'generating' is the one outcome to avoid").
 */
export async function writeDigestFailure(digestId: string, message: string): Promise<void> {
  const db = getPipelineDb();
  await db.query(
    `update public.digests set status = 'failed', error = $2 where id = $1 and status = 'generating'`,
    [digestId, message],
  );
}
