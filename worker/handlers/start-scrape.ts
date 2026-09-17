import type { Job, JobWithMetadata } from "pg-boss";

import type { JobData } from "@/lib/queue/jobs";
import { requireEnv } from "@/lib/env";
import { FREE_TIER_MAX_PRODUCTS_PER_COMPETITOR } from "@/lib/tier";
import { log, logError } from "../log";
import { getScrapeTarget, recordScrapeRun } from "../db";
import { enqueueFromWorker } from "../queue-client";

const APIFY_API_URL = "https://api.apify.com/v2";

/**
 * trovevault/shopify-products-scraper — verified live against the actor and
 * the exact input n8n's last production run used (2026-09-14): domains, a
 * residential proxy, and maxProducts capped to the free-tier product limit
 * (lib/tier.ts) to protect the Apify free plan's budget. One fixed actor for
 * every competitor, so this is a constant, not config.
 */
const ACTOR_ID = "dsYHmuqeHvtR7NYxx";

/** How long after starting a run the backstop check looks for completion (ADR-0005). */
const CHECK_DELAY_SECONDS = 30 * 60;

/**
 * Ceiling passed to Apify itself for how long one run is allowed to take.
 * Real observed runtimes for this actor are 10-15s (Apify console) — 5
 * minutes is generous headroom for a slower catalog while still capping a
 * genuinely hung run, which otherwise has no ceiling we control at all.
 */
const RUN_TIMEOUT_SECONDS = 300;

/**
 * Start one Apify scrape for a competitor: run the Actor directly, record the
 * run so process_apify_run can resolve its competitor later, and schedule the
 * delayed backstop check in case the completion webhook is lost.
 */
export async function startScrape(jobs: Job<JobData["start_scrape"]>[]): Promise<void> {
  // JobHandlers (lib/queue/jobs.ts) types every handler's parameter as the
  // plain Job for shared simplicity; this job's work options set
  // includeMetadata: true specifically so pg-boss actually hands it
  // JobWithMetadata (retryCount and the rest) at runtime.
  const withMetadata = jobs as unknown as JobWithMetadata<JobData["start_scrape"]>[];
  for (const job of withMetadata) {
    try {
      await runStartScrape(job.data.competitorId, job.data.signalTypes, job.retryCount);
    } catch (error) {
      logError("start_scrape_failed", error, { competitorId: job.data.competitorId });
      throw error;
    }
  }
}

async function runStartScrape(
  competitorId: string,
  signalTypes?: string[],
  retryCount?: number,
): Promise<void> {
  const competitor = await getScrapeTarget(competitorId);
  if (!competitor) {
    throw new Error(`No active competitor ${competitorId} to scrape`);
  }

  log("start_scrape_started", {
    competitorId,
    name: competitor.name,
    url: competitor.url,
    signalTypes: signalTypes ?? "all",
    retryCount: retryCount ?? 0,
  });

  const run = await startApifyRun(competitor.url);
  await recordScrapeRun(run.id, competitor.id, signalTypes, retryCount);

  log("start_scrape_run_created", { competitorId, runId: run.id });

  await enqueueFromWorker(
    "check_apify_run",
    { runId: run.id, competitorId: competitor.id },
    { singletonKey: run.id, startAfter: CHECK_DELAY_SECONDS },
  );
}

/**
 * Verified against the actor (`GET /v2/acts/dsYHmuqeHvtR7NYxx`) and the ad-hoc
 * webhook mechanism (Apify docs: `webhooks` query param, base64-encoded JSON
 * array of {eventTypes, requestUrl, payloadTemplate, headersTemplate}).
 *
 * NOTE: Apify's current docs (docs.apify.com/api/v2/actors-runs-post) only
 * document `/v2/actors/{actorId}/runs` (plural) for starting a run — `/v2/acts/`
 * isn't mentioned there. This is demonstrably still working (real successful
 * runs in the Apify console), so it's very likely a still-functional legacy
 * alias from before Apify renamed "acts" to "actors" — but unlike the GET
 * endpoints (fixed to /v2/actor-runs/ elsewhere in this codebase, confirmed
 * current), this write endpoint hasn't been switched, since it's the
 * critical path that actually starts a scrape and deserves a deliberate
 * decision rather than a drive-by change alongside a read-only status fix.
 */
async function startApifyRun(url: string): Promise<{ id: string }> {
  // Trailing slash on APP_URL (easy to paste in as-is from a browser address
  // bar) would otherwise double up before /api/webhooks/apify.
  const appUrl = requireEnv("APP_URL").replace(/\/+$/, "");
  const webhooks = [
    {
      eventTypes: ["ACTOR.RUN.SUCCEEDED"],
      requestUrl: `${appUrl}/api/webhooks/apify`,
      payloadTemplate: "{\"resource\":{{resource}}}",
      // Never in the URL (ADR-0005) — the route reads this header in constant time.
      headersTemplate: JSON.stringify({ "x-webhook-secret": requireEnv("APIFY_WEBHOOK_SECRET") }),
    },
  ];
  const webhooksParam = Buffer.from(JSON.stringify(webhooks)).toString("base64");

  const res = await fetch(
    `${APIFY_API_URL}/acts/${ACTOR_ID}/runs?webhooks=${encodeURIComponent(webhooksParam)}&timeout=${RUN_TIMEOUT_SECONDS}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requireEnv("APIFY_API_TOKEN")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        domains: [url],
        maxProducts: FREE_TIER_MAX_PRODUCTS_PER_COMPETITOR,
        proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
      }),
    },
  );

  if (!res.ok) {
    throw new Error(`Failed to start Apify run for ${url}: ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as { data: { id: string } };
  return body.data;
}
