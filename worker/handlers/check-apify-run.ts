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

async function runCheck(runId: string, competitorId: string): Promise<void> {
  const run = await fetchApifyRun(runId);
  log("check_apify_run_polled", { runId, competitorId, apifyStatus: run.status });

  if (run.status === "SUCCEEDED") {
    // The webhook made it through, or we're the backstop. Either way,
    // process the run. process_apify_run is idempotent (exclusive policy).
    await enqueueFromWorker("process_apify_run", { runId });
  } else if (run.status === "RUNNING") {
    // Still going. Reschedule for ~5 minutes from now.
    await enqueueFromWorker(
      "check_apify_run",
      { runId, competitorId },
      { singletonKey: runId, startAfter: 300 },
    );
  } else if (run.status === "FAILED" || run.status === "ABORTED") {
    // Apify failed or the run was stopped. Log it, don't enqueue the processor.
    // The competitor is waiting for the next scheduled start_scrape.
    const message = `Apify run ${run.status.toLowerCase()}`;
    await updateScrapeRunStatus(runId, "failed", message);
    console.error(
      JSON.stringify({
        event: "apify_run_terminal_failure",
        runId,
        competitorId,
        status: run.status,
      }),
    );
  } else {
    // TIMED_OUT or other status — treat as an error (retryable).
    const message = `Apify run ${runId} has unexpected status: ${run.status}`;
    await updateScrapeRunStatus(runId, "failed", message);
    throw new Error(message);
  }
}

/**
 * GET /v2/runs/{runId} — check the run's status. Returns the full run object.
 * Status values: READY, RUNNING, SUCCEEDED, FAILED, TIMED_OUT, ABORTED.
 */
async function fetchApifyRun(runId: string): Promise<{ status: string }> {
  const res = await fetch(`${APIFY_API_URL}/runs/${runId}`, {
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
