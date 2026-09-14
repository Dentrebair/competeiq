import { Pool } from "pg";
import type { WorkHandler } from "pg-boss";

import { databaseConnection } from "@/lib/queue/connection";
import { JOBS, type JobHandlers, type JobName } from "@/lib/queue/jobs";

import { log, logError } from "./log";
import { heartbeat, type PipelineMode } from "./pipeline-state";
import { startWorkerQueue } from "./queue";

const HEARTBEAT_MS = 60_000;
/** How long a shutdown waits for a running job before pg-boss abandons it for a retry. */
const STOP_TIMEOUT_MS = 30_000;

export interface WorkerOptions {
  databaseUrl: string;
  handlers: JobHandlers;
  heartbeatMs?: number;
}

export interface RunningWorker {
  mode(): PipelineMode | null;
  stop(): Promise<void>;
}

/**
 * The worker process: heartbeat, Pipeline Mode, and job handlers.
 *
 * Every heartbeat also reads Pipeline Mode. While `live` the handlers take jobs;
 * while `paused` they are unsubscribed, after any running job finishes. Jobs
 * keep arriving either way (webhooks, schedules, Run Now), so pausing holds work
 * rather than dropping it.
 */
export async function startWorker({
  databaseUrl,
  handlers,
  heartbeatMs = HEARTBEAT_MS,
}: WorkerOptions): Promise<RunningWorker> {
  const db = new Pool({
    ...databaseConnection(databaseUrl),
    application_name: "competeiq-worker",
    max: 2,
  });
  db.on("error", (error) => logError("db_pool_error", error));

  const boss = await startWorkerQueue(databaseUrl, db);
  const names = Object.keys(handlers) as JobName[];
  const working = new Set<JobName>();
  let mode: PipelineMode | null = null;
  let ticking: Promise<void> | null = null;

  // Tracks each subscription, so a failure partway through is retried on the
  // next heartbeat without subscribing any queue twice.
  async function apply(next: PipelineMode): Promise<void> {
    for (const name of names) {
      if (next === "live" && !working.has(name)) {
        const handler = handlers[name] as WorkHandler<object>;
        await boss.work(name, JOBS[name].work, handler);
        working.add(name);
      } else if (next === "paused" && working.has(name)) {
        await boss.offWork(name, { wait: true });
        working.delete(name);
      }
    }
    if (next !== mode) log(next === "live" ? "pipeline_live" : "pipeline_paused", { handlers: names });
    mode = next;
  }

  const tick = (): Promise<void> => {
    ticking ??= heartbeat(db)
      .then(apply)
      .finally(() => {
        ticking = null;
      });
    return ticking;
  };

  await tick();
  log("worker_started", { mode, handlers: names });

  const timer = setInterval(() => {
    tick().catch((error) => logError("heartbeat_failed", error));
  }, heartbeatMs);

  return {
    mode: () => mode,
    async stop() {
      clearInterval(timer);
      await ticking?.catch(() => {});
      await boss.stop({ graceful: true, timeout: STOP_TIMEOUT_MS });
      await db.end();
    },
  };
}
