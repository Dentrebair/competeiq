import { PgBoss, type SendOptions } from "pg-boss";

import { requireEnv } from "@/lib/env";
import { databaseConnection } from "@/lib/queue/connection";
import type { JobData, JobName } from "@/lib/queue/jobs";

/**
 * The worker's own way to enqueue a job from inside a handler — e.g. the
 * stale-run sweep handing a recovered success to process_apify_run
 * (worker/handlers/sweep-stale-runs.ts).
 *
 * A second, lightweight PgBoss client, same shape as lib/queue/intake.ts but
 * for pipeline_worker instead of pipeline_intake. Not the `boss` instance
 * worker/worker.ts already runs (that one owns migration/supervision/cron —
 * see its own file); handlers aren't handed that reference today, and running
 * a second `migrate: false, supervise: false` client alongside it is the same
 * trick intake.ts already uses to talk to the same schema safely.
 */
let client: Promise<PgBoss> | null = null;

function queue(): Promise<PgBoss> {
  client ??= (async () => {
    const boss = new PgBoss({
      ...databaseConnection(requireEnv("PIPELINE_WORKER_DATABASE_URL")),
      application_name: "competeiq-worker-handlers",
      max: 2,
      migrate: false,
      supervise: false,
      schedule: false,
    });
    boss.on("error", (error) => {
       
      console.error(JSON.stringify({ event: "queue_error", message: error.message }));
    });
    return boss.start();
  })().catch((error: unknown) => {
    client = null;
    throw error;
  });
  return client;
}

/** Adds a job. Resolves to null when the queue's policy ignored it as a duplicate. */
export async function enqueueFromWorker<N extends JobName>(
  name: N,
  data: JobData[N],
  options?: SendOptions,
): Promise<string | null> {
  return (await queue()).send(name, data, options);
}
