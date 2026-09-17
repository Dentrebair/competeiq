import { PgBoss } from "pg-boss";
import type { Pool } from "pg";

import { databaseConnection } from "@/lib/queue/connection";
import { JOBS, type JobName } from "@/lib/queue/jobs";

import { logError } from "./log";

/**
 * Starts pg-boss as the owner of the `pgboss` schema.
 *
 * The worker installs and upgrades pg-boss itself (`migrate: true`). It cannot
 * create schemas, so 07 created `pgboss` and the worker runs with
 * `createSchema: false`. It also runs pg-boss's maintenance and the cron that
 * turns schedules into jobs.
 */
export async function startWorkerQueue(databaseUrl: string, db: Pool): Promise<PgBoss> {
  const boss = new PgBoss({
    ...databaseConnection(databaseUrl),
    application_name: "competeiq-worker",
    max: 4,
    createSchema: false,
    migrate: true,
    supervise: true,
    schedule: true,
  });
  boss.on("error", (error) => logError("queue_error", error));
  await boss.start();

  // Creating an existing queue is a no-op, so this is safe on every start.
  for (const name of Object.keys(JOBS) as JobName[]) {
    await boss.createQueue(name, JOBS[name].queue);
  }

  // The one schedule the worker sets up itself, not per-competitor and not
  // driven by any app action — see worker/handlers/sweep-stale-runs.ts.
  // schedule() replaces in place on a matching key, so this is safe on every
  // start rather than only the first.
  await boss.schedule("sweep_stale_runs", "* * * * *", {}, { key: "sweep_stale_runs" });

  await grantIntake(boss, db);
  return boss;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Grants the website exactly what adding a job and writing a schedule use.
 *
 * Only the worker can issue these: it owns every table pg-boss created. The
 * list follows pg-boss's SQL for send() and schedule(). If an upgrade makes the
 * website fail with "permission denied", `npm run test:queue` fails first.
 */
async function grantIntake(boss: PgBoss, db: Pool): Promise<void> {
  const tables = [...new Set((await boss.getQueues()).map((queue) => queue.table))];
  for (const table of tables) {
    if (!IDENTIFIER.test(table)) throw new Error(`Unexpected pg-boss job table name: ${table}`);
  }

  await db.query("grant select on pgboss.version, pgboss.queue to pipeline_intake");
  await db.query("grant select, insert, update, delete on pgboss.schedule to pipeline_intake");
  await db.query(
    `grant select, insert on ${tables.map((table) => `pgboss.${table}`).join(", ")} to pipeline_intake`,
  );
}
