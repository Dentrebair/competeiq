import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { clearSchedule, enqueue, setSchedule, stopIntakeQueue } from "@/lib/queue/intake";
import { startWorker } from "@/worker/worker";

/**
 * The worker and the website against a real database with the real roles.
 *
 * `npm run test:queue` builds that database from supabase/00 → 07 and sets the
 * URLs below. `npm test` skips this file.
 */

const WORKER_URL = process.env.QUEUE_TEST_WORKER_URL ?? "";
const INTAKE_URL = process.env.QUEUE_TEST_INTAKE_URL ?? "";
const ADMIN_URL = process.env.QUEUE_TEST_ADMIN_URL ?? "";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!WORKER_URL || !INTAKE_URL || !ADMIN_URL)("worker queue", () => {
  let admin: Client;

  const setMode = (mode: "live" | "paused") =>
    admin.query("update public.pipeline_state set mode = $1", [mode]);

  beforeAll(async () => {
    process.env.PIPELINE_INTAKE_DATABASE_URL = INTAKE_URL;
    admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
  });

  afterAll(async () => {
    await stopIntakeQueue();
    await admin?.end();
  });

  it("installs the queue and restarts cleanly", async () => {
    await setMode("paused");
    const first = await startWorker({ databaseUrl: WORKER_URL, handlers: {} });
    await first.stop();

    // Queue creation and the website's grants must both be safe to repeat.
    const second = await startWorker({ databaseUrl: WORKER_URL, handlers: {} });
    expect(second.mode()).toBe("paused");
    await second.stop();

    const { rows } = await admin.query<{ name: string; policy: string }>(
      "select name, policy from pgboss.queue where name not like '\\_\\_%' order by name",
    );
    expect(rows).toEqual([
      { name: "check_apify_run", policy: "exclusive" },
      { name: "generate_digest", policy: "exclusive" },
      { name: "process_apify_run", policy: "exclusive" },
      { name: "start_scrape", policy: "short" },
    ]);
  }, 60_000);

  it("lets the website add jobs and write schedules, and nothing else", async () => {
    expect(await enqueue("start_scrape", { competitorId: "c-1" }, { singletonKey: "c-1" })).toBeTruthy();
    // A second scrape for the same competitor collapses into the waiting one.
    expect(await enqueue("start_scrape", { competitorId: "c-1" }, { singletonKey: "c-1" })).toBeNull();

    await setSchedule("start_scrape", "c-1", "0 */3 * * *", { competitorId: "c-1" }, { singletonKey: "c-1" });
    await clearSchedule("start_scrape", "c-1");

    const website = new Client({ connectionString: INTAKE_URL });
    await website.connect();
    try {
      await expect(website.query("select pgboss.create_queue('rogue', '{}'::jsonb)")).rejects.toThrow(
        /permission denied/,
      );
      await expect(website.query("select count(*) from public.alerts")).rejects.toThrow(/permission denied/);
      await expect(website.query("select count(*) from public.competitor_products")).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await website.end();
    }
  }, 60_000);

  it("holds jobs while paused, runs them once live, and stops again when paused", async () => {
    await setMode("paused");
    const handled: string[] = [];
    const worker = await startWorker({
      databaseUrl: WORKER_URL,
      handlers: {
        process_apify_run: async ([job]) => {
          handled.push(job.data.runId);
        },
      },
      heartbeatMs: 250,
    });

    try {
      expect(worker.mode()).toBe("paused");
      expect(await enqueue("process_apify_run", { runId: "run-1" }, { singletonKey: "run-1" })).toBeTruthy();
      expect(await enqueue("process_apify_run", { runId: "run-1" }, { singletonKey: "run-1" })).toBeNull();

      await sleep(2_000);
      expect(handled).toEqual([]);

      await setMode("live");
      await vi.waitFor(() => expect(handled).toEqual(["run-1"]), { timeout: 30_000, interval: 250 });

      await setMode("paused");
      await vi.waitFor(() => expect(worker.mode()).toBe("paused"), { timeout: 5_000, interval: 100 });
      expect(await enqueue("process_apify_run", { runId: "run-2" }, { singletonKey: "run-2" })).toBeTruthy();
      await sleep(12_000);
      expect(handled).toEqual(["run-1"]);

      const { rows } = await admin.query<{ fresh: boolean }>(
        "select heartbeat_at > now() - interval '5 seconds' as fresh from public.pipeline_state",
      );
      expect(rows[0].fresh).toBe(true);
    } finally {
      await worker.stop();
    }
  }, 90_000);
});
