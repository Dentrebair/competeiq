import "server-only";

import { PgBoss, type SendOptions } from "pg-boss";

import { requireEnv } from "@/lib/env";
import { databaseConnection } from "@/lib/queue/connection";
import type { JobData, JobName } from "@/lib/queue/jobs";

/**
 * The website's side of the queue: add jobs and write schedules, nothing else.
 *
 * Connects as `pipeline_intake`, which can reach no app table and cannot create
 * queues (supabase/07-pipeline-worker.sql, Q25). The worker grants its queue
 * rights on every start, so a website that starts before the worker has ever
 * run gets "permission denied" until it has.
 *
 * Both services must run the same pg-boss version. This instance never
 * migrates, and pg-boss refuses to start against a schema from another version.
 */

const cache = globalThis as typeof globalThis & { __competeiqIntake?: Promise<PgBoss> };

export function isQueueConfigured(): boolean {
  return Boolean(process.env.PIPELINE_INTAKE_DATABASE_URL);
}

function intake(): Promise<PgBoss> {
  // Cached on globalThis so dev-server reloads reuse one pool instead of leaking one per edit.
  cache.__competeiqIntake ??= (async () => {
    const boss = new PgBoss({
      ...databaseConnection(requireEnv("PIPELINE_INTAKE_DATABASE_URL")),
      application_name: "competeiq-web",
      max: 2,
      migrate: false,
      supervise: false,
      schedule: false,
    });
    boss.on("error", (error) =>
      console.error(JSON.stringify({ event: "queue_error", message: error.message })),
    );
    return boss.start();
  })().catch((error: unknown) => {
    // Let the next call retry rather than caching the failure forever.
    cache.__competeiqIntake = undefined;
    throw error;
  });

  return cache.__competeiqIntake;
}

/** Adds a job. Resolves to null when the queue's policy ignored it as a duplicate. */
export async function enqueue<N extends JobName>(
  name: N,
  data: JobData[N],
  options?: SendOptions,
): Promise<string | null> {
  return (await intake()).send(name, data, options);
}

/** Creates or replaces the recurring job identified by `key`. */
export async function setSchedule<N extends JobName>(
  name: N,
  key: string,
  cron: string,
  data: JobData[N],
  options?: SendOptions,
): Promise<void> {
  await (await intake()).schedule(name, cron, data, { ...options, key });
}

export async function clearSchedule(name: JobName, key: string): Promise<void> {
  await (await intake()).unschedule(name, key);
}

/** Closes the pool. For tests and shutdown; the next call opens a new one. */
export async function stopIntakeQueue(): Promise<void> {
  const pending = cache.__competeiqIntake;
  cache.__competeiqIntake = undefined;
  if (pending) await (await pending).stop({ graceful: false });
}
