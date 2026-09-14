import type { Job } from "pg-boss";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JobData } from "@/lib/queue/jobs";

/**
 * generate_digest against a mocked Claude client and database — no network,
 * no Postgres, no real Anthropic call.
 */

const mockParse = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { parse: mockParse } })),
}));

const db = vi.hoisted(() => ({
  getDigestLock: vi.fn(),
  getUnreadAlertsForDigest: vi.fn(),
  getActiveCompetitorNames: vi.fn(),
  getBrandProfileForDigest: vi.fn(),
  getLastReadyDigestPeriodEnd: vi.fn(),
  writeDigestReady: vi.fn(),
  writeDigestFailure: vi.fn(),
}));
vi.mock("@/worker/db", () => db);

const { generateDigest } = await import("@/worker/handlers/generate-digest");

function jobFor(digestId: string): Job<JobData["generate_digest"]>[] {
  return [{ data: { digestId } } as Job<JobData["generate_digest"]>];
}

const ALERT = {
  id: 42,
  competitor_name: "Acme Co",
  signal_type: "sku_price_change",
  severity: "high",
  summary: "Price dropped.",
  impact: "Pressures entry price.",
  recommended_action: "Reprice.",
  created_at: "2026-09-10T00:00:00.000Z",
};

const PARSED_OUTPUT = {
  headline: "A quiet day.",
  priority_action: {
    action: "Reprice the widget",
    why_now: "Competitor undercut by 20%",
    competitor: "Acme Co",
    related_alert_ids: ["42"],
  },
  patterns: [],
  quiet_competitors: ["Other Co"],
  period_start: "2026-09-09T00:00:00.000Z",
  period_end: "2026-09-10T00:00:00.000Z",
};

function claudeSucceeds(usage: Partial<{ input_tokens: number; output_tokens: number }> = {}) {
  mockParse.mockResolvedValue({
    parsed_output: PARSED_OUTPUT,
    usage: {
      input_tokens: usage.input_tokens ?? 1000,
      output_tokens: usage.output_tokens ?? 200,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ANTHROPIC_API_KEY = "test-key";
  db.getDigestLock.mockResolvedValue({ id: "digest-1" });
  db.getUnreadAlertsForDigest.mockResolvedValue([ALERT]);
  db.getActiveCompetitorNames.mockResolvedValue(["Acme Co", "Other Co"]);
  db.getBrandProfileForDigest.mockResolvedValue(null);
  db.getLastReadyDigestPeriodEnd.mockResolvedValue(null);
  db.writeDigestReady.mockResolvedValue(undefined);
  db.writeDigestFailure.mockResolvedValue(undefined);
});

describe("generateDigest", () => {
  it("writes the digest ready with the parsed output and real alert ids", async () => {
    claudeSucceeds({ input_tokens: 5000, output_tokens: 800 });

    await generateDigest(jobFor("digest-1"));

    expect(db.writeDigestFailure).not.toHaveBeenCalled();
    expect(db.writeDigestReady).toHaveBeenCalledTimes(1);
    const call = db.writeDigestReady.mock.calls[0][0];
    expect(call.digestId).toBe("digest-1");
    expect(call.headline).toBe(PARSED_OUTPUT.headline);
    expect(call.priorityAction).toEqual(PARSED_OUTPUT.priority_action);
    expect(call.quietCompetitors).toEqual(["Other Co"]);
    // Real bigint id from the DB row, not the string citation in priority_action.
    expect(call.alertIds).toEqual([42]);
    expect(call.claudeUsage).toEqual({
      input_tokens: 5000,
      output_tokens: 800,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  it("uses the previous ready digest's period_end as this one's period_start", async () => {
    claudeSucceeds();
    db.getLastReadyDigestPeriodEnd.mockResolvedValue(new Date("2026-09-08T12:00:00.000Z"));

    await generateDigest(jobFor("digest-1"));

    const call = db.writeDigestReady.mock.calls[0][0];
    expect(call.periodStart.toISOString()).toBe("2026-09-08T12:00:00.000Z");
  });

  it("falls back to the earliest unread alert when there is no previous digest", async () => {
    claudeSucceeds();
    db.getUnreadAlertsForDigest.mockResolvedValue([
      { ...ALERT, id: 1, created_at: "2026-09-05T00:00:00.000Z" },
      { ...ALERT, id: 2, created_at: "2026-09-07T00:00:00.000Z" },
    ]);

    await generateDigest(jobFor("digest-1"));

    const call = db.writeDigestReady.mock.calls[0][0];
    expect(call.periodStart.toISOString()).toBe("2026-09-05T00:00:00.000Z");
    expect(call.alertIds).toEqual([1, 2]);
  });

  it("falls back to 24 hours back when there is neither a previous digest nor any alerts", async () => {
    claudeSucceeds();
    db.getUnreadAlertsForDigest.mockResolvedValue([]);

    await generateDigest(jobFor("digest-1"));

    const call = db.writeDigestReady.mock.calls[0][0];
    const spanMs = call.periodEnd.getTime() - call.periodStart.getTime();
    expect(spanMs).toBe(24 * 60 * 60 * 1000);
    expect(call.alertIds).toEqual([]);
  });

  it("writes a terminal failure, without throwing, when Claude fails on every retry", async () => {
    mockParse.mockRejectedValue(new Error("Opus is down"));

    await expect(generateDigest(jobFor("digest-1"))).resolves.toBeUndefined();

    expect(mockParse).toHaveBeenCalledTimes(2); // matches WF-03: Max Tries 2
    expect(db.writeDigestReady).not.toHaveBeenCalled();
    expect(db.writeDigestFailure).toHaveBeenCalledWith("digest-1", expect.stringContaining("Opus is down"));
  }, 10_000);

  it("writes a terminal failure when Claude returns no parsed output", async () => {
    mockParse.mockResolvedValue({ parsed_output: null, usage: { input_tokens: 1, output_tokens: 1 } });

    await generateDigest(jobFor("digest-1"));

    expect(db.writeDigestReady).not.toHaveBeenCalled();
    expect(db.writeDigestFailure).toHaveBeenCalledWith("digest-1", expect.stringContaining("no parsed output"));
  });

  it("throws (for pg-boss to retry) rather than writing a failure when the lock is gone", async () => {
    db.getDigestLock.mockResolvedValue(null);

    await expect(generateDigest(jobFor("digest-1"))).rejects.toThrow(/not.*'generating'/);

    expect(db.writeDigestFailure).not.toHaveBeenCalled();
    expect(mockParse).not.toHaveBeenCalled();
  });
});
