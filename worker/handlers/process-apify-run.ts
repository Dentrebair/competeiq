import type { Job } from "pg-boss";
import Anthropic from "@anthropic-ai/sdk";

import type { JobData } from "@/lib/queue/jobs";
import {
  evaluateSignals,
  interpretationRequest,
  parseInterpretation,
  alertRow,
  baselineRows,
} from "@/lib/pipeline/signal-evaluation";
import type { ApifyProduct, Interpretation, DetectedChange } from "@/lib/pipeline/signal-evaluation";
import type { SignalType } from "@/lib/signals";
import { baselineHistoryRows } from "@/lib/pipeline/baseline-history";
import { requireEnv } from "@/lib/env";
import { log, logError } from "../log";
import {
  getCompetitorForRun,
  getBaseline,
  persistProcessedRun,
  recordRunError,
  updateScrapeRunStatus,
} from "../db";

const APIFY_API_URL = "https://api.apify.com/v2";

/**
 * Turn one finished Collection Run into Alerts and a new Baseline.
 *
 * 1. Fetch the run and dataset from Apify API
 * 2. Evaluate signals: detect changes (price, catalog, promo)
 * 3. Call Claude Haiku for interpretation (with retries)
 * 4. Persist in one transaction: alerts + baseline updates
 * 5. Deliver via Realtime to the browser
 */
export async function processApifyRun(jobs: Job<JobData["process_apify_run"]>[]): Promise<void> {
  for (const job of jobs) {
    try {
      await processRun(job);
    } catch (error) {
      logError("process_apify_run_failed", error, { runId: job.data.runId });
      throw error;
    }
  }
}

async function processRun(job: Job<JobData["process_apify_run"]>): Promise<void> {
  const { runId } = job.data;

  // The job carries only a run ID (ADR-0005: never trust the webhook body),
  // so the competitor comes from our own record, not from Apify or the webhook.
  const competitor = await getCompetitorForRun(runId);
  if (!competitor) {
    throw new Error(`No scrape_runs record for run ${runId} — cannot resolve its competitor`);
  }

  log("process_apify_run_started", { runId, competitorId: competitor.id, name: competitor.name });
  await updateScrapeRunStatus(runId, "processing");

  try {
    const run = await fetchApifyRun(runId);
    if (run.status !== "SUCCEEDED") {
      throw new Error(`Apify run ${runId} is ${run.status}, not SUCCEEDED`);
    }
    if (!run.defaultDatasetId) {
      throw new Error(`Apify run ${runId} has no dataset`);
    }

    const products = await fetchApifyDataset(run.defaultDatasetId);
    // Global rule: an empty dataset from a successful run is a failure signal
    // until proven otherwise, not "nothing changed".
    if (products.length === 0) {
      throw new Error(`Apify run ${runId} returned an empty dataset`);
    }
    log("process_apify_run_dataset_fetched", { runId, productCount: products.length });

    const baseline = await getBaseline(competitor.id);
    const changes: DetectedChange[] = evaluateSignals(
      products,
      baseline,
      competitor,
      competitor.requestedSignals as SignalType[] | null,
    );
    log("process_apify_run_changes_evaluated", {
      runId,
      changeCount: changes.length,
      requestedSignals: competitor.requestedSignals ?? "all",
    });

    const interpretations = await Promise.all(
      changes.map((change) => callClaudeWithRetry(change)),
    );
    const alerts = changes.map((change, i) => alertRow(change, interpretations[i], runId));

    const now = new Date();
    await persistProcessedRun({
      runId,
      competitorId: competitor.id,
      alerts,
      baseline: baselineRows(products, competitor.id, now),
      baselineHistory: baselineHistoryRows(products, baseline, competitor.id, runId),
    });

    await updateScrapeRunStatus(runId, "succeeded");
    log("process_apify_run_succeeded", { runId, competitorId: competitor.id, alertCount: alerts.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordRunError(competitor.id, message);
    await updateScrapeRunStatus(runId, "failed", message);
    throw error;
  }
}

/**
 * Verified against a live `GET /v2/actor-runs/{id}` response (run
 * 7K7t0Nh2X0lqm7i9D, Death Wish Coffee, 2026-08-23): the response is wrapped
 * in `data`, and `status`/`defaultDatasetId` are exactly these field names.
 */
async function fetchApifyRun(runId: string) {
  const res = await fetch(`${APIFY_API_URL}/actor-runs/${runId}`, {
    headers: { Authorization: `Bearer ${requireEnv("APIFY_API_TOKEN")}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch Apify run ${runId}: ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as {
    data: { id: string; status: string; defaultDatasetId: string | null; finishedAt: string };
  };
  return body.data;
}

async function fetchApifyDataset(datasetId: string): Promise<ApifyProduct[]> {
  const res = await fetch(`${APIFY_API_URL}/datasets/${datasetId}/items`, {
    headers: { Authorization: `Bearer ${requireEnv("APIFY_API_TOKEN")}` },
  });

  if (!res.ok) {
    throw new Error(
      `Failed to fetch Apify dataset ${datasetId}: ${res.status} ${res.statusText}`,
    );
  }

  const items = (await res.json()) as ApifyProduct[];
  return items;
}

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  anthropicClient ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropicClient;
}

async function callClaudeWithRetry(
  change: Parameters<typeof interpretationRequest>[0],
  maxRetries: number = 3,
): Promise<Interpretation | null> {
  const client = getAnthropicClient();
  const request = interpretationRequest(change);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await client.messages.create({
        ...request,
        messages: request.messages,
      });

      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");

      return parseInterpretation(text);
    } catch (error) {
      if (attempt === maxRetries - 1) {
        logError("claude_call_exhausted", error, {
          change: change.product_title,
          competitor: change.competitor_name,
        });
        return null;
      }
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return null;
}
