import crypto from "crypto";

import { requireEnv } from "@/lib/env";
import { enqueue } from "@/lib/queue/intake";

/**
 * Apify's completion webhook for ACTOR.RUN.SUCCEEDED events.
 *
 * Apify fires this immediately when an actor run finishes. The webhook body
 * includes `resource: { id: "run-id", status: "SUCCEEDED", ... }`, but per
 * ADR-0005 we never trust it — the run ID is extracted here, then refetched
 * from Apify's API inside `process_apify_run` to confirm status and download
 * the dataset ourselves. This route validates the secret, reads only the run ID,
 * and enqueues the job for the worker.
 *
 * The x-webhook-secret header is validated in constant time to prevent timing
 * attacks that could leak the secret.
 */

interface ApifyWebhookBody {
  resource?: { id?: unknown };
}

// Timing-safe comparison: always reads both strings in full, never shorts out early.
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function POST(request: Request) {
  // Extract and validate the secret header in constant time.
  const headerSecret = request.headers.get("x-webhook-secret");
  const expectedSecret = requireEnv("APIFY_WEBHOOK_SECRET");

  if (!headerSecret || !constantTimeEqual(headerSecret, expectedSecret)) {
    // Never log either secret value — just enough to tell "no header sent" apart
    // from "header sent, but doesn't match", since those point at different fixes.
    console.error(
      JSON.stringify({
        event: "apify_webhook_unauthorized",
        reason: headerSecret ? "secret_mismatch" : "missing_header",
      }),
    );
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Parse the body — be strict, since Apify controls what we receive.
  let body: ApifyWebhookBody;
  try {
    body = (await request.json()) as ApifyWebhookBody;
  } catch {
    return Response.json({ error: "Malformed request body" }, { status: 400 });
  }

  // Extract the run ID.
  const runId = typeof body.resource?.id === "string" ? body.resource.id : null;
  if (!runId) {
    return Response.json({ error: "Missing resource.id in webhook body" }, { status: 400 });
  }

  // Enqueue the processor job. The singletonKey (the run ID) ensures at most
  // one process_apify_run job exists per run — duplicate webhooks collapse.
  try {
    await enqueue("process_apify_run", { runId }, { singletonKey: runId });
    console.log(JSON.stringify({ event: "apify_webhook_received", runId }));
    // Return 202 Accepted immediately — the actual processing happens async
    // in the background, same as generate_digest. The webhook body is gone by
    // the time the worker reads the run from Apify, so a disconnect here is safe.
    return Response.json({ ok: true }, { status: 202 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    console.error(JSON.stringify({ event: "apify_webhook_failed", error: detail, runId }));
    // Apify will retry on 5xx. 500 is safest here — transient queue failures
    // should be retried; if the queue is misconfigured, Apify's retry is the
    // least-bad outcome.
    return Response.json({ error: detail }, { status: 500 });
  }
}
