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

const { checkApifyRun } = await import("@/worker/handlers/check-apify-run");

function jobFor(runId: string, competitorId: string): Job<JobData["check_apify_run"]>[] {
  return [{ data: { runId, competitorId } } as Job<JobData["check_apify_run"]>];
}

function mockApifyCheckStatus(status: string) {
  const fetchMock = vi.fn(async (url: string) => {
    expect(url).toBe(`https://api.apify.com/v2/runs/run-xyz`);
    return new Response(JSON.stringify({ data: { status } }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APIFY_API_TOKEN = "test-token";
  queueClient.enqueueFromWorker.mockResolvedValue("job-id");
});

describe("checkApifyRun", () => {
  it("enqueues process_apify_run when run has SUCCEEDED", async () => {
    mockApifyCheckStatus("SUCCEEDED");

    await checkApifyRun(jobFor("run-xyz", "comp-1"));

    expect(queueClient.enqueueFromWorker).toHaveBeenCalledWith("process_apify_run", {
      runId: "run-xyz",
    });
  });

  it("reschedules check_apify_run for 5 min when run is still RUNNING", async () => {
    mockApifyCheckStatus("RUNNING");

    await checkApifyRun(jobFor("run-xyz", "comp-1"));

    expect(queueClient.enqueueFromWorker).toHaveBeenCalledWith(
      "check_apify_run",
      { runId: "run-xyz", competitorId: "comp-1" },
      { singletonKey: "run-xyz", startAfter: 300 },
    );
  });

  it("logs error and does not enqueue when run FAILED", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockApifyCheckStatus("FAILED");

    await checkApifyRun(jobFor("run-xyz", "comp-1"));

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("apify_run_terminal_failure"),
    );
    expect(queueClient.enqueueFromWorker).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("logs error and does not enqueue when run ABORTED", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockApifyCheckStatus("ABORTED");

    await checkApifyRun(jobFor("run-xyz", "comp-1"));

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("apify_run_terminal_failure"),
    );
    expect(queueClient.enqueueFromWorker).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("throws on unexpected status", async () => {
    mockApifyCheckStatus("TIMED_OUT");

    await expect(checkApifyRun(jobFor("run-xyz", "comp-1"))).rejects.toThrow(
      "unexpected status: TIMED_OUT",
    );
  });
});
