import type { Job } from "pg-boss";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JobData } from "@/lib/queue/jobs";

/**
 * start_scrape against a mocked Apify API, the database and the worker's
 * internal enqueue client — no network, no Postgres.
 */

const db = vi.hoisted(() => ({
  getScrapeTarget: vi.fn(),
  recordScrapeRun: vi.fn(),
}));
vi.mock("@/worker/db", () => db);

const queueClient = vi.hoisted(() => ({
  enqueueFromWorker: vi.fn(),
}));
vi.mock("@/worker/queue-client", () => queueClient);

const { startScrape } = await import("@/worker/handlers/start-scrape");

const COMPETITOR = { id: "comp-1", name: "Acme Co", url: "https://acme.example" };

function jobFor(competitorId: string): Job<JobData["start_scrape"]>[] {
  return [{ data: { competitorId } } as Job<JobData["start_scrape"]>];
}

function mockApifyRunStart(opts: { ok?: boolean; runId?: string } = {}) {
  const { ok = true, runId = "run-new" } = opts;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toContain("/acts/dsYHmuqeHvtR7NYxx/runs?webhooks=");
    expect(init?.method).toBe("POST");
    if (!ok) return new Response("boom", { status: 500, statusText: "Internal Error" });
    return new Response(JSON.stringify({ data: { id: runId } }), { status: 201 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APIFY_API_TOKEN = "test-token";
  process.env.APP_URL = "https://app.example";
  process.env.APIFY_WEBHOOK_SECRET = "test-secret";
  db.getScrapeTarget.mockResolvedValue(COMPETITOR);
  db.recordScrapeRun.mockResolvedValue(undefined);
  queueClient.enqueueFromWorker.mockResolvedValue("job-id");
});

describe("startScrape", () => {
  it("starts the Actor with the competitor's URL, records the run, and schedules the backstop check", async () => {
    const fetchMock = mockApifyRunStart({ runId: "run-abc" });

    await startScrape(jobFor("comp-1"));

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body).toEqual({
      domains: ["https://acme.example"],
      maxProducts: 100,
      proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
    });

    expect(db.recordScrapeRun).toHaveBeenCalledWith("run-abc", "comp-1");

    expect(queueClient.enqueueFromWorker).toHaveBeenCalledWith(
      "check_apify_run",
      { runId: "run-abc", competitorId: "comp-1" },
      { singletonKey: "run-abc", startAfter: 1800 },
    );
  });

  it("sends the webhook secret only in the headers template, never the URL", async () => {
    const fetchMock = mockApifyRunStart();

    await startScrape(jobFor("comp-1"));

    const [url] = fetchMock.mock.calls[0];
    expect(url).not.toContain("test-secret");

    const webhooksParam = new URL(url as string).searchParams.get("webhooks")!;
    const webhooks = JSON.parse(Buffer.from(webhooksParam, "base64").toString("utf8"));
    expect(webhooks).toEqual([
      {
        eventTypes: ["ACTOR.RUN.SUCCEEDED"],
        requestUrl: "https://app.example/api/webhooks/apify",
        payloadTemplate: '{"resource":{{resource}}}',
        headersTemplate: JSON.stringify({ "x-webhook-secret": "test-secret" }),
      },
    ]);
  });

  it("throws when the competitor cannot be found or is inactive", async () => {
    db.getScrapeTarget.mockResolvedValue(null);

    await expect(startScrape(jobFor("missing"))).rejects.toThrow(/No active competitor/);
    expect(db.recordScrapeRun).not.toHaveBeenCalled();
    expect(queueClient.enqueueFromWorker).not.toHaveBeenCalled();
  });

  it("throws and never records a run when Apify rejects the start request", async () => {
    mockApifyRunStart({ ok: false });

    await expect(startScrape(jobFor("comp-1"))).rejects.toThrow(/Failed to start Apify run/);
    expect(db.recordScrapeRun).not.toHaveBeenCalled();
    expect(queueClient.enqueueFromWorker).not.toHaveBeenCalled();
  });
});
