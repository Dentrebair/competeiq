import type { Job } from "pg-boss";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JobData } from "@/lib/queue/jobs";

/**
 * process_apify_run against mocked Apify, Claude and the database — no
 * network, no Postgres. Signal Evaluation itself is covered by
 * test/pipeline/signal-evaluation.parity.test.ts; this file is about the
 * handler's own wiring: fetch → evaluate → interpret → persist, and what
 * happens on each kind of failure.
 */

const mockCreate = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: mockCreate } })),
}));

const db = vi.hoisted(() => ({
  getCompetitorForRun: vi.fn(),
  getBaseline: vi.fn(),
  persistProcessedRun: vi.fn(),
  recordRunError: vi.fn(),
  updateScrapeRunStatus: vi.fn(),
}));
vi.mock("@/worker/db", () => db);

const { processApifyRun } = await import("@/worker/handlers/process-apify-run");

const COMPETITOR = { id: "comp-1", name: "Acme Co" };

function jobFor(runId: string): Job<JobData["process_apify_run"]>[] {
  return [{ data: { runId } } as Job<JobData["process_apify_run"]>];
}

function mockApify(opts: { status?: string; datasetId?: string | null; products?: unknown[] }) {
  const { status = "SUCCEEDED", datasetId = "ds-1", products = [] } = opts;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/actor-runs/")) {
        return new Response(
          JSON.stringify({ data: { id: "run-x", status, defaultDatasetId: datasetId } }),
          { status: 200 },
        );
      }
      if (url.includes("/datasets/")) {
        return new Response(JSON.stringify(products), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
}

function claudeReply(json: string) {
  mockCreate.mockResolvedValue({ content: [{ type: "text", text: json }] });
}

const PRICE_CHANGE_PRODUCT = {
  url: "https://acme.example/products/widget",
  title: "Widget",
  priceMin: 20,
  compareAtPrice: null,
  currency: "USD",
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APIFY_API_TOKEN = "test-token";
  process.env.ANTHROPIC_API_KEY = "test-key";
  db.getCompetitorForRun.mockResolvedValue(COMPETITOR);
  db.getBaseline.mockResolvedValue([]);
  db.persistProcessedRun.mockResolvedValue(undefined);
  db.recordRunError.mockResolvedValue(undefined);
  db.updateScrapeRunStatus.mockResolvedValue(undefined);
});

describe("processApifyRun", () => {
  it("evaluates, interprets and persists a run with a detected change", async () => {
    mockApify({ products: [PRICE_CHANGE_PRODUCT] });
    db.getBaseline.mockResolvedValue([{ product_handle: "widget", last_price: 10 }]);
    claudeReply('{"summary":"Price doubled. Real move.","impact":"Pressures entry price.","recommended_action":"Reprice widget."}');

    await processApifyRun(jobFor("run-1"));

    expect(db.recordRunError).not.toHaveBeenCalled();
    expect(db.persistProcessedRun).toHaveBeenCalledTimes(1);
    const call = db.persistProcessedRun.mock.calls[0][0];
    expect(call.runId).toBe("run-1");
    expect(call.competitorId).toBe("comp-1");
    expect(call.alerts).toHaveLength(1);
    expect(call.alerts[0]).toMatchObject({
      signal_type: "sku_price_change",
      ai_available: true,
      summary: "Price doubled. Real move.",
      dedupe_key: "run-1:sku_price_change:widget",
    });
    expect(call.baseline).toHaveLength(1);
    expect(call.baselineHistory).toEqual([
      expect.objectContaining({ product_handle: "widget", was_new: false, previous_price: 10, current_price: 20 }),
    ]);
    expect(db.updateScrapeRunStatus).toHaveBeenCalledWith("run-1", "processing");
    expect(db.updateScrapeRunStatus).toHaveBeenCalledWith(
      "run-1",
      "succeeded",
      undefined,
      "ds-1",
      "SUCCEEDED",
    );
  });

  it("writes an unclassified alert when Claude fails on every retry", async () => {
    mockApify({ products: [PRICE_CHANGE_PRODUCT] });
    db.getBaseline.mockResolvedValue([{ product_handle: "widget", last_price: 10 }]);
    mockCreate.mockRejectedValue(new Error("Claude is down"));

    await processApifyRun(jobFor("run-2"));

    expect(mockCreate).toHaveBeenCalledTimes(3);
    const call = db.persistProcessedRun.mock.calls[0][0];
    expect(call.alerts[0].ai_available).toBe(false);
    expect(call.alerts[0].recommended_action).toBe("Review the change manually.");
  }, 10_000);

  it("throws and records the error, without persisting, on an empty dataset", async () => {
    mockApify({ products: [] });

    await expect(processApifyRun(jobFor("run-3"))).rejects.toThrow(/empty dataset/);

    expect(db.persistProcessedRun).not.toHaveBeenCalled();
    expect(db.recordRunError).toHaveBeenCalledWith("comp-1", expect.stringMatching(/empty dataset/));
  });

  it("throws and records the error when the run did not succeed", async () => {
    mockApify({ status: "FAILED" });

    await expect(processApifyRun(jobFor("run-4"))).rejects.toThrow(/not SUCCEEDED/);
    expect(db.recordRunError).toHaveBeenCalledWith("comp-1", expect.stringMatching(/not SUCCEEDED/));
    expect(db.updateScrapeRunStatus).toHaveBeenCalledWith(
      "run-4",
      "failed",
      expect.stringMatching(/not SUCCEEDED/),
      undefined,
      "FAILED",
    );
  });

  it("throws and records the error when the run has no dataset", async () => {
    mockApify({ datasetId: null });

    await expect(processApifyRun(jobFor("run-5"))).rejects.toThrow(/no dataset/);
    expect(db.recordRunError).toHaveBeenCalledWith("comp-1", expect.stringMatching(/no dataset/));
  });

  it("throws without recording an error when the competitor cannot be resolved", async () => {
    db.getCompetitorForRun.mockResolvedValue(null);

    await expect(processApifyRun(jobFor("run-6"))).rejects.toThrow(/cannot resolve its competitor/);
    expect(db.recordRunError).not.toHaveBeenCalled();
    expect(db.persistProcessedRun).not.toHaveBeenCalled();
  });

  it("reports no changes as success without persisting anything", async () => {
    // Same price as baseline: no product, catalog or promo signal fires.
    mockApify({ products: [{ ...PRICE_CHANGE_PRODUCT, priceMin: 10 }] });
    db.getBaseline.mockResolvedValue([{ product_handle: "widget", last_price: 10 }]);

    await processApifyRun(jobFor("run-7"));

    expect(mockCreate).not.toHaveBeenCalled();
    expect(db.persistProcessedRun).toHaveBeenCalledTimes(1);
    expect(db.persistProcessedRun.mock.calls[0][0].alerts).toEqual([]);
    // Baseline still gets recorded even with no signal fired.
    expect(db.persistProcessedRun.mock.calls[0][0].baseline).toHaveLength(1);
  });
});
