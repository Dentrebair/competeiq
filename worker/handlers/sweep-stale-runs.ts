import type { Job } from "pg-boss";

import type { JobData } from "@/lib/queue/jobs";
import { requireEnv } from "@/lib/env";
import { log, logError } from "../log";
import { getStaleRuns, updateScrapeRunStatus } from "../db";
import { enqueueFromWorker } from "../queue-client";

const APIFY_API_URL = "https://api.apify.com/v2";

/**
 * How old a running/processing row must be before it's treated as stuck.
 * Verified against real Apify run durations for this actor (a few seconds to
 * under a minute — see the Apify console) — nothing genuinely still working
 * should ever be this old, so there is no "too aggressive" case to worry
 * about here.
 */
const STALE_THRESHOLD_MINUTES = 3;

/**
 * A single transient network blip while checking Apify shouldn't be enough
 * to write a failure — only a check that fails three times in a row writes
 * anything to the database at all.
 */
const MAX_APIFY_CHECK_ATTEMPTS = 3;
const APIFY_CHECK_RETRY_DELAY_MS = 10_000;

/**
 * The backstop for the backstop. Fixed, always-on (scheduled once at worker
 * startup, not per-competitor — see worker/queue.ts), independent of
 * check_apify_run's own reschedule chain entirely: it doesn't matter whether
 * that chain is healthy, expired, or exhausted its retries, because this
 * just asks "what does the database say right now?" on its own clock.
 *
 * For every stale row found, resolves it by asking Apify directly what
 * actually happened, and classifies the outcome into exactly one of three
 * categories (recorded in scrape_runs.error) matching the three ways the
 * backstop chain can break:
 *
 *   apify_unreachable        — even this direct check can't reach Apify's
 *                              API (repeated transient failures).
 *   reschedule_chain_broken  — Apify resolved this run a while ago
 *                              (succeeded or failed), but nothing ever
 *                              recorded it — most likely a worker restart
 *                              dropped a scheduled recheck.
 *   apify_hung                — Apify itself still hasn't reached a
 *                              terminal status, long past any real run's
 *                              duration.
 *
 * A recovered success is NOT written here directly — it's handed to
 * process_apify_run so the normal success path (alerts, baseline) still
 * owns writing "succeeded".
 */
export async function sweepStaleRuns(jobs: Job<JobData["sweep_stale_runs"]>[]): Promise<void> {
  // No payload to read (JobData["sweep_stale_runs"] is empty) — the loop
  // exists only to match every other handler's shape and to run once per
  // batched job, same as the rest.
  for (const _job of jobs) {
    try {
      await runSweep();
    } catch (error) {
      logError("sweep_stale_runs_failed", error);
      throw error;
    }
  }
}

async function runSweep(): Promise<void> {
  const stale = await getStaleRuns(STALE_THRESHOLD_MINUTES);
  if (stale.length === 0) return;

  log("sweep_stale_runs_found", { count: stale.length, runIds: stale.map((r) => r.run_id) });

  for (const run of stale) {
    await resolveStaleRun(run.run_id, run.competitor_id);
  }
}

async function resolveStaleRun(runId: string, competitorId: string): Promise<void> {
  const checked = await fetchApifyRunStatusWithRetries(runId);
  if (!checked.ok) {
    // All MAX_APIFY_CHECK_ATTEMPTS attempts failed — this is the only case
    // that writes to the database on a check failure. A single blip that
    // succeeds on attempt 2 or 3 leaves no trace at all.
    await updateScrapeRunStatus(
      runId,
      "failed",
      `stale_run:apify_unreachable — ${checked.error}`,
      undefined,
      "UNREACHABLE",
    );
    log("sweep_stale_run_resolved", {
      runId,
      competitorId,
      category: "apify_unreachable",
      attempts: MAX_APIFY_CHECK_ATTEMPTS,
    });
    return;
  }
  const apifyStatus = checked.status;

  if (apifyStatus === "SUCCEEDED") {
    // The result exists — let the normal success path record it (alerts,
    // baseline), not this sweep.
    await enqueueFromWorker("process_apify_run", { runId });
    log("sweep_stale_run_resolved", { runId, competitorId, category: "recovered_success" });
    return;
  }

  if (apifyStatus === "FAILED" || apifyStatus === "ABORTED" || apifyStatus === "TIMED-OUT") {
    await updateScrapeRunStatus(
      runId,
      "failed",
      `stale_run:reschedule_chain_broken — apify ${apifyStatus.toLowerCase()}`,
      undefined,
      apifyStatus,
    );
    log("sweep_stale_run_resolved", { runId, competitorId, category: "reschedule_chain_broken" });
    return;
  }

  // Still READY/RUNNING/TIMING-OUT/ABORTING (or a genuinely unexpected
  // value) well past any real run's duration — the hang is on Apify's
  // side, not in our own pipeline. Deliberately resolved now rather than
  // waiting for check_apify_run's own 30-minute-later first look — nothing
  // real takes this long for this actor.
  await updateScrapeRunStatus(
    runId,
    "failed",
    `stale_run:apify_hung — still ${apifyStatus} after ${STALE_THRESHOLD_MINUTES}m`,
    undefined,
    "HUNG",
  );
  log("sweep_stale_run_resolved", { runId, competitorId, category: "apify_hung" });
}

type ApifyCheckResult = { ok: true; status: string } | { ok: false; error: string };

/**
 * Tries up to MAX_APIFY_CHECK_ATTEMPTS times, a few seconds apart, before
 * reporting failure — so one transient network blip never writes anything
 * to the database (see resolveStaleRun).
 */
async function fetchApifyRunStatusWithRetries(runId: string): Promise<ApifyCheckResult> {
  let lastError = "unknown error";
  for (let attempt = 1; attempt <= MAX_APIFY_CHECK_ATTEMPTS; attempt++) {
    try {
      const status = await fetchApifyRunStatus(runId);
      return { ok: true, status };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < MAX_APIFY_CHECK_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, APIFY_CHECK_RETRY_DELAY_MS));
      }
    }
  }
  return { ok: false, error: lastError };
}

/**
 * GET /v2/actor-runs/{runId} — the current, documented endpoint (same one
 * process-apify-run.ts and check-apify-run.ts use). An older `/v2/runs/`
 * path was in use here before — not a documented endpoint.
 */
async function fetchApifyRunStatus(runId: string): Promise<string> {
  const res = await fetch(`${APIFY_API_URL}/actor-runs/${runId}`, {
    headers: { Authorization: `Bearer ${requireEnv("APIFY_API_TOKEN")}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch Apify run ${runId}: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { data: { status: string } };
  return body.data.status;
}
