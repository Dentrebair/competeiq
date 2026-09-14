import { requireEnv } from "@/lib/env";
import type { JobHandlers } from "@/lib/queue/jobs";

import { log, logError } from "./log";
import { startWorker } from "./worker";
import { processApifyRun } from "./handlers/process-apify-run";
import { startScrape } from "./handlers/start-scrape";

/**
 * Entry point for the Railway worker service: `npm run start:worker`.
 *
 * Handlers are added as each job is built (spec, delivery slices 3–5). A queue
 * with no handler keeps its jobs until one exists.
 */
const HANDLERS: JobHandlers = {
  process_apify_run: processApifyRun,
  start_scrape: startScrape,
};

async function main(): Promise<void> {
  const worker = await startWorker({
    databaseUrl: requireEnv("PIPELINE_WORKER_DATABASE_URL"),
    handlers: HANDLERS,
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("worker_stopping", { signal });
    try {
      await worker.stop();
      log("worker_stopped");
      process.exit(0);
    } catch (error) {
      logError("worker_stop_failed", error);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  // Exit non-zero so Railway restarts the service.
  logError("worker_start_failed", error);
  process.exit(1);
});
