import type { Job } from "pg-boss";

import type { JobData } from "@/lib/queue/jobs";
import { requireEnv } from "@/lib/env";
import { log, logError } from "../log";
import { updateScrapeRunStatus } from "../db";
import { enqueueFromWorker } from "../queue-client";

const APIFY_API_URL = "https://api.apify.com/v2";

/**
 * The delayed backstop check (~30 min after start_scrape) for a lost ACTOR.RUN.SUCCEEDED
 * webhook. Polls Apify to see if the run is done; if so, enqueues process_apify_run.
 * If still running, reschedules itself. If failed, logs the error and moves on.
 *
 * Idempotent: called with an exclusive policy, so only one per run can be in
 * flight or pending. Multiple re-schedules collapse to one.
 */
export async function checkApifyRun(jobs: Job<JobData["check_apify_run"]>[]): Promise<void> {
  for (const job of jobs) {
    try {
      await runCheck(job.data.runId, job.data.competitorId);
    } catch (error) {
      logError("check_apify_run_failed", error, { runId: job.data.runId });
      throw error;
    }
  }
}

/**
 * Verified against Apify's current docs (docs.apify.com/api/v2/actor-run-get):
 * terminal statuses use a HYPHEN, not an underscore. Never write "TIMED_OUT" —
 * Apify's API never returns that string, so a comparison against it would
 * silently never match.
 */
const STILL_GOING = new Set(["READY", "RUNNING", "TIMING-OUT", "ABORTING"]);

async function runCheck(runId: string, competitorId: string): Promise<void> {
  const run = await fetchApifyRun(runId);
  log("check_apify_run_polled", { runId, competitorId, apifyStatus: run.status });

  if (run.status === "SUCCEEDED") {
    // The webhook made it through, or we're the backstop. Either way,
    // process the run. process_apify_run is idempotent (exclusive policy).
    await enqueueFromWorker("process_apify_run", { runId });
  } else if (STILL_GOING.has(run.status)) {
    // Still going — READY (queued), RUNNING, or mid-way through timing out
    // or aborting (Apify itself hasn't landed on a terminal status yet).
    // Reschedule for ~5 minutes from now.
    await enqueueFromWorker(
      "check_apify_run",
      { runId, competitorId },
      { singletonKey: runId, startAfter: 300 },
    );
  } else if (run.status === "FAILED" || run.status === "ABORTED" || run.status === "TIMED-OUT") {
    // A genuine terminal failure. Log it, don't enqueue the processor.
    // The competitor is waiting for the next scheduled start_scrape.
    const message = `Apify run ${run.status.toLowerCase()}`;
    await updateScrapeRunStatus(runId, "failed", message, undefined, run.status);
    console.error(
      JSON.stringify({
        event: "apify_run_terminal_failure",
        runId,
        competitorId,
        status: run.status,
      }),
    );
  } else {
    // Truly unexpected value — not one of Apify's documented statuses.
    // Retryable, since this might be a transient parsing/API issue.
    const message = `Apify run ${runId} has unexpected status: ${run.status}`;
    await updateScrapeRunStatus(runId, "failed", message, undefined, run.status);
    throw new Error(message);
  }
}

/**
 * GET /v2/actor-runs/{runId} — the current, documented endpoint for one run
 * by id (docs.apify.com/api/v2/actor-run-get); same endpoint
 * process-apify-run.ts already uses. An older `/v2/runs/{runId}` path was in
 * use here before — not a documented endpoint, standardized on this one.
 *
 * Status values, exactly as Apify returns them (hyphens, not underscores):
 * READY, RUNNING, TIMING-OUT, ABORTING (in progress) — SUCCEEDED, FAILED,
 * TIMED-OUT, ABORTED (terminal).
 */
async function fetchApifyRun(runId: string): Promise<{ status: string }> {
  const res = await fetch(`${APIFY_API_URL}/actor-runs/${runId}`, {
    headers: {
      Authorization: `Bearer ${requireEnv("APIFY_API_TOKEN")}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch Apify run ${runId}: ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as { data: { status: string } };
  return body.data;
}
