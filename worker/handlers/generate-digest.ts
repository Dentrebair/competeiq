import type { Job } from "pg-boss";
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";

import type { JobData } from "@/lib/queue/jobs";
import {
  DIGEST_MODEL,
  DIGEST_MAX_TOKENS,
  DIGEST_EFFORT,
  DIGEST_SYSTEM_PROMPT,
  DIGEST_SCHEMA,
} from "@/lib/pipeline/digest-prompt";
import { buildDigestUserContent, type DigestAlertInput } from "@/lib/pipeline/digest-request";
import { logError } from "../log";
import {
  getDigestLock,
  getUnreadAlertsForDigest,
  getActiveCompetitorNames,
  getBrandProfileForDigest,
  getLastReadyDigestPeriodEnd,
  writeDigestReady,
  writeDigestFailure,
} from "../db";

/** Matches WF-03's node settings: Retry on Fail, Max Tries 2, Wait Between Tries 5000. */
const CLAUDE_RETRY_ATTEMPTS = 2;
const CLAUDE_RETRY_DELAY_MS = 5000;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Fill in the digest row the app locked — replaces WF-03.
 *
 * Unlike process_apify_run, a Claude failure here is terminal rather than
 * retried by the job queue: WF-03's own design writes status='failed' rather
 * than leaving the lock stuck at 'generating' (which the app's 15-minute
 * reaper would otherwise have to clean up). So a Claude failure, after its own
 * retries, does not rethrow — the job "succeeds" by recording the failure.
 * An upstream failure (can't read alerts, lock vanished) does rethrow, since
 * nothing was attempted yet and pg-boss's own retry is appropriate there.
 */
export async function generateDigest(jobs: Job<JobData["generate_digest"]>[]): Promise<void> {
  for (const job of jobs) {
    try {
      await runGenerateDigest(job.data.digestId);
    } catch (error) {
      logError("generate_digest_failed", error, { digestId: job.data.digestId });
      throw error;
    }
  }
}

async function runGenerateDigest(digestId: string): Promise<void> {
  const lock = await getDigestLock(digestId);
  if (!lock) {
    throw new Error(`Digest ${digestId} is not (or is no longer) in 'generating' state`);
  }

  const [alerts, competitorNames, brand, lastPeriodEnd] = await Promise.all([
    getUnreadAlertsForDigest(),
    getActiveCompetitorNames(),
    getBrandProfileForDigest(),
    getLastReadyDigestPeriodEnd(),
  ]);

  const periodEnd = new Date();
  const periodStart = periodStartFor(lastPeriodEnd, alerts, periodEnd);
  const userContent = buildDigestUserContent({ alerts, competitorNames, brand, periodStart, periodEnd });

  let message;
  try {
    message = await callClaudeForDigest(userContent);
  } catch (error) {
    await writeDigestFailure(digestId, error instanceof Error ? error.message : String(error));
    return;
  }

  const output = message.parsed_output;
  if (!output) {
    await writeDigestFailure(digestId, "Claude returned no parsed output");
    return;
  }

  await writeDigestReady({
    digestId,
    headline: output.headline,
    priorityAction: output.priority_action,
    patterns: output.patterns,
    quietCompetitors: output.quiet_competitors,
    // The real bigint ids of every alert actually sent — distinct from the
    // string citations inside priority_action/patterns (see digest-request.ts).
    alertIds: alerts.map((a) => a.id),
    periodStart,
    periodEnd,
    claudeUsage: {
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
      cache_read_input_tokens: message.usage.cache_read_input_tokens ?? undefined,
      cache_creation_input_tokens: message.usage.cache_creation_input_tokens ?? undefined,
    },
  });
}

/**
 * No previous ready digest → the earliest unread alert; no alerts either →
 * a day back, so a fresh install's first digest reports a sane window instead
 * of an instant one.
 */
function periodStartFor(
  lastPeriodEnd: Date | null,
  alerts: DigestAlertInput[],
  periodEnd: Date,
): Date {
  if (lastPeriodEnd) return lastPeriodEnd;
  if (alerts.length > 0) {
    const earliest = alerts.reduce(
      (min, a) => (a.created_at < min ? a.created_at : min),
      alerts[0].created_at,
    );
    return new Date(earliest);
  }
  return new Date(periodEnd.getTime() - ONE_DAY_MS);
}

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  anthropicClient ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropicClient;
}

async function callClaudeForDigest(userContent: string) {
  const client = getAnthropicClient();
  const format = jsonSchemaOutputFormat(DIGEST_SCHEMA);

  for (let attempt = 0; attempt < CLAUDE_RETRY_ATTEMPTS; attempt++) {
    try {
      return await client.messages.parse({
        model: DIGEST_MODEL,
        max_tokens: DIGEST_MAX_TOKENS,
        // No `thinking` field — Opus 5 runs adaptive thinking by default, and
        // cross-competitor pattern-finding is the one place that's wanted.
        output_config: { effort: DIGEST_EFFORT, format },
        system: [{ type: "text", text: DIGEST_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userContent }],
      });
    } catch (error) {
      if (attempt === CLAUDE_RETRY_ATTEMPTS - 1) throw error;
      logError("digest_claude_call_retrying", error, { attempt });
      await new Promise((resolve) => setTimeout(resolve, CLAUDE_RETRY_DELAY_MS));
    }
  }
  throw new Error("unreachable");
}
