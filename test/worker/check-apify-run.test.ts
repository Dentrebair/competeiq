import type { Job } from "pg-boss";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JobData } from "@/lib/queue/jobs";

/**
 * check_apify_run against a mocked Apify API and the worker's internal enqueue
 * client — no network, no Postgres.
 */

const queueClient = vi.hoisted(() => ({
  enqueueFromWorker: vi.fn(),
}));
vi.mock("@/worker/queue-client", () => queueClient);

const db = vi.hoisted(() => ({
  updateScrapeRunStatus: vi.fn(),
}));
vi.mock("@/worker/db", () => db);

const { checkApifyRun } = await import("@/worker/handlers/check-apify-run");

function jobFor(runId: string, competitorId: string): Job<JobData["check_apify_run"]>[] {
  return [{ data: { runId, competitorId } } as Job<JobData["check_apify_run"]>];
}

function mockApifyCheckStatus(status: string) {
  const fetchMock = vi.fn(async (url: string) => {
    expect(url).toBe(`https://api.apify.com/v2/actor-runs/run-xyz`);
    return new Response(JSON.stringify({ data: { status } }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APIFY_API_TOKEN = "test-token";
  queueClient.enqueueFromWorker.mockResolvedValue("job-id");
  db.updateScrapeRunStatus.mockResolvedValue(undefined);
});

describe("checkApifyRun", () => {
  it("enqueues process_apify_run when run has SUCCEEDED", async () => {
    mockApifyCheckStatus("SUCCEEDED");

    await checkApifyRun(jobFor("run-xyz", "comp-1"));

    expect(queueClient.enqueueFromWorker).toHaveBeenCalledWith("process_apify_run", {
      runId: "run-xyz",
    });
  });

  it.each(["READY", "RUNNING", "TIMING-OUT", "ABORTING"])(
    "reschedules check_apify_run for 5 min when run is still %s",
    async (status) => {
      mockApifyCheckStatus(status);

      await checkApifyRun(jobFor("run-xyz", "comp-1"));

      expect(queueClient.enqueueFromWorker).toHaveBeenCalledWith(
        "check_apify_run",
        { runId: "run-xyz", competitorId: "comp-1" },
        { singletonKey: "run-xyz", startAfter: 300 },
      );
    },
  );

  it("logs error, records the failure, and does not enqueue when run FAILED", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockApifyCheckStatus("FAILED");

    await checkApifyRun(jobFor("run-xyz", "comp-1"));

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("apify_run_terminal_failure"),
    );
    expect(db.updateScrapeRunStatus).toHaveBeenCalledWith(
      "run-xyz",
      "failed",
      expect.stringContaining("failed"),
      undefined,
      "FAILED",
    );
    expect(queueClient.enqueueFromWorker).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("logs error, records the failure, and does not enqueue when run ABORTED", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockApifyCheckStatus("ABORTED");

    await checkApifyRun(jobFor("run-xyz", "comp-1"));

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("apify_run_terminal_failure"),
    );
    expect(db.updateScrapeRunStatus).toHaveBeenCalledWith(
      "run-xyz",
      "failed",
      expect.stringContaining("aborted"),
      undefined,
      "ABORTED",
    );
    expect(queueClient.enqueueFromWorker).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("logs error, records the failure, and does not enqueue when run TIMED-OUT (hyphen, matching Apify's real API)", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockApifyCheckStatus("TIMED-OUT");

    await checkApifyRun(jobFor("run-xyz", "comp-1"));

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("apify_run_terminal_failure"),
    );
    expect(db.updateScrapeRunStatus).toHaveBeenCalledWith(
      "run-xyz",
      "failed",
      expect.stringContaining("timed-out"),
      undefined,
      "TIMED-OUT",
    );
    expect(queueClient.enqueueFromWorker).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("records the failure and throws on a genuinely unexpected status", async () => {
    mockApifyCheckStatus("SOMETHING_NEW");

    await expect(checkApifyRun(jobFor("run-xyz", "comp-1"))).rejects.toThrow(
      "unexpected status: SOMETHING_NEW",
    );
    expect(db.updateScrapeRunStatus).toHaveBeenCalledWith(
      "run-xyz",
      "failed",
      expect.stringContaining("SOMETHING_NEW"),
      undefined,
      "SOMETHING_NEW",
    );
  });
});
