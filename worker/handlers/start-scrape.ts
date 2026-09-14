import type { Job } from "pg-boss";

import type { JobData } from "@/lib/queue/jobs";
import { requireEnv } from "@/lib/env";
import { logError } from "../log";
import { getScrapeTarget, recordScrapeRun } from "../db";
import { enqueueFromWorker } from "../queue-client";

const APIFY_API_URL = "https://api.apify.com/v2";

/**
 * trovevault/shopify-products-scraper — verified live against the actor and
 * the exact input n8n's last production run used (2026-09-14): domains,
 * maxProducts: 100 (not the actor's example of 10), and residential proxies.
 * One fixed actor for every competitor, so this is a constant, not config.
 */
const ACTOR_ID = "dsYHmuqeHvtR7NYxx";

/** How long after starting a run the backstop check looks for completion (ADR-0005). */
const CHECK_DELAY_SECONDS = 30 * 60;

/**
 * Start one Apify scrape for a competitor: run the Actor directly, record the
 * run so process_apify_run can resolve its competitor later, and schedule the
 * delayed backstop check in case the completion webhook is lost.
 */
export async function startScrape(jobs: Job<JobData["start_scrape"]>[]): Promise<void> {
  for (const job of jobs) {
    try {
      await runStartScrape(job.data.competitorId);
    } catch (error) {
      logError("start_scrape_failed", error, { competitorId: job.data.competitorId });
      throw error;
    }
  }
}

async function runStartScrape(competitorId: string): Promise<void> {
  const competitor = await getScrapeTarget(competitorId);
  if (!competitor) {
    throw new Error(`No active competitor ${competitorId} to scrape`);
  }

  const run = await startApifyRun(competitor.url);
  await recordScrapeRun(run.id, competitor.id);

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
    `${APIFY_API_URL}/acts/${ACTOR_ID}/runs?webhooks=${encodeURIComponent(webhooksParam)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requireEnv("APIFY_API_TOKEN")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        domains: [url],
        maxProducts: 100,
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
