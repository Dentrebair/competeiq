import type { Job, Queue, WorkOptions } from "pg-boss";

import type { SignalType } from "@/lib/signals";

/**
 * Every kind of Processing Job, in one place.
 *
 * Shared by the worker, which creates the queues and runs the handlers, and by
 * the website, which only adds jobs. Type imports only, so either side can load
 * it.
 *
 * A queue's policy is fixed when the queue is first created, so choose it here
 * deliberately:
 *   short      at most one job waiting per singletonKey. Scrapes queued while
 *              the pipeline is paused collapse to one per competitor.
 *   exclusive  at most one job waiting or running per singletonKey. A duplicate
 *              Apify notification is ignored while the first is in flight. Once
 *              that job has finished a late duplicate is accepted, so handlers
 *              must be idempotent.
 */

export interface JobData {
  /**
   * Start one Apify scrape for a competitor. Queued by its schedule or by Run
   * Now. `signalTypes`, when present, restricts which signals
   * process_apify_run evaluates from this run's data — the picker on Run
   * Now. Undefined (the schedule) means no restriction: every live signal is
   * evaluated, same as before this field existed.
   */
  start_scrape: { competitorId: string; signalTypes?: SignalType[] };
  /** The backstop for a lost webhook: look at a run about 30 minutes after it started. */
  check_apify_run: { runId: string; competitorId: string };
  /** Turn one finished Collection Run into Alerts and a new Baseline. */
  process_apify_run: { runId: string };
  /** Fill in the digest row the app locked. */
  generate_digest: { digestId: string };
  /**
   * The backstop for the backstop: a fixed, always-on sweep (not
   * per-competitor, never enqueued by the app) that catches any scrape_runs
   * row stuck in running/processing well past how long a real run has ever
   * taken — the case where check_apify_run's own reschedule chain broke
   * (worker restart, exhausted retries, or Apify itself never resolving).
   * No payload: it queries the database for whatever is stale right now.
   */
  sweep_stale_runs: Record<string, never>;
}

export type JobName = keyof JobData;

interface JobDefinition {
  queue: Omit<Queue, "name">;
  work: WorkOptions;
}

export const JOBS = {
  start_scrape: {
    queue: { policy: "short", retryLimit: 2, retryDelay: 300, expireInSeconds: 300 },
    work: { batchSize: 1, pollingIntervalSeconds: 10 },
  },
  check_apify_run: {
    queue: { policy: "exclusive", retryLimit: 3, retryDelay: 300, expireInSeconds: 300 },
    work: { batchSize: 1, pollingIntervalSeconds: 30 },
  },
  process_apify_run: {
    queue: {
      policy: "exclusive",
      retryLimit: 5,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 900,
    },
    work: { batchSize: 1, pollingIntervalSeconds: 10 },
  },
  generate_digest: {
    queue: { policy: "exclusive", retryLimit: 2, retryDelay: 60, expireInSeconds: 1200 },
    work: { batchSize: 1, pollingIntervalSeconds: 10 },
  },
  sweep_stale_runs: {
    // No retry: the next scheduled tick, one minute later, is already a retry.
    queue: { policy: "exclusive", retryLimit: 0, expireInSeconds: 120 },
    work: { batchSize: 1, pollingIntervalSeconds: 15 },
  },
} satisfies Record<JobName, JobDefinition>;

export type JobHandlers = {
  [N in JobName]?: (jobs: Job<JobData[N]>[]) => Promise<void>;
};
