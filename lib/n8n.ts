import "server-only";

import { requireEnv } from "@/lib/env";

/**
 * The outbound edge to n8n.
 *
 * This is the app's only write path into the intelligence engine. Everything the
 * operator initiates — registering a competitor, forcing a scrape, asking for a
 * fresh digest — goes through here, and nothing else in the app talks to n8n.
 *
 * `server-only` is load-bearing: N8N_WEBHOOK_SECRET must never reach a client
 * bundle. Importing this module from a Client Component is a build error, which
 * is the outcome we want.
 */

export type N8nWebhook = "configLoader" | "manualTrigger" | "digest";

/**
 * The signal vocabulary lives in lib/signals.ts, which has no "server-only"
 * marker — client code needs those strings too, and importing them through this
 * module would drag `server-only` into the browser bundle.
 */
export type { SignalType } from "@/lib/signals";
import type { SignalType } from "@/lib/signals";

/** One entry in the Config Loader's `signal_configs` array. */
export interface SignalConfigPayload {
  signal_type: SignalType;
  frequency_hours: number;
  enabled: boolean;
}

export interface CompetitorPayload {
  id: string;
  name: string;
  url: string;
  /** n8n expects this alongside `name`; today they carry the same value. */
  brand_name: string;
}

const WEBHOOK_ENV: Record<N8nWebhook, string> = {
  configLoader: "N8N_WEBHOOK_CONFIG_LOADER",
  manualTrigger: "N8N_WEBHOOK_MANUAL_TRIGGER",
  digest: "N8N_WEBHOOK_DIGEST",
};

/**
 * Whether a failed call is safe to retry automatically.
 *
 * `manualTrigger` is not. It fires an Apify actor run, which costs money and
 * consumes the competitor's scrape budget; a retry after an ambiguous timeout can
 * launch a second run for the same click. Config Loader is an upsert keyed on the
 * competitor and surface, so replaying it converges. Digest is guarded by the
 * partial unique index on `digests.status`, so a duplicate call is rejected by the
 * database rather than producing a second Opus 5 run.
 */
const RETRY_SAFE: Record<N8nWebhook, boolean> = {
  configLoader: true,
  manualTrigger: false,
  digest: false,
};

/** Per-webhook timeouts. These bound the *app's* wait, not n8n's work. */
const TIMEOUT_MS: Record<N8nWebhook, number> = {
  configLoader: 20_000,
  manualTrigger: 15_000,
  // WF-03 runs Opus 5 with thinking on and can take minutes. We are NOT waiting
  // for that — the workflow must be configured to respond immediately (a
  // "Respond to Webhook" node at the front, mode "Respond Immediately"), then do
  // its work and write the result to Supabase. The app learns the digest is ready
  // over Realtime. If this call ever actually takes minutes, the workflow is
  // misconfigured to respond when the last node finishes.
  digest: 10_000,
};

export type N8nResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number; retryable: boolean };

interface CallOptions {
  /** Override the default timeout for this webhook. */
  timeoutMs?: number;
  /** Attempts for retry-safe webhooks. Ignored when the webhook is not retry-safe. */
  attempts?: number;
}

/**
 * Call an n8n webhook with the shared secret.
 *
 * Never throws. Returns a discriminated result so Route Handlers can map failure
 * onto an HTTP status deliberately instead of leaking a stack trace. Errors are
 * described in terms the operator can act on, because several of them surface
 * directly in the UI.
 */
export async function callN8n<T = unknown>(
  webhook: N8nWebhook,
  payload: Record<string, unknown>,
  options: CallOptions = {},
): Promise<N8nResult<T>> {
  let url: string;
  let secret: string;
  try {
    url = requireEnv(WEBHOOK_ENV[webhook]);
    secret = requireEnv("N8N_WEBHOOK_SECRET");
  } catch (error) {
    // Misconfiguration, not a transient failure. Retrying will not help.
    return {
      ok: false,
      error: error instanceof Error ? error.message : "n8n is not configured",
      retryable: false,
    };
  }

  const maxAttempts = RETRY_SAFE[webhook] ? Math.max(1, options.attempts ?? 2) : 1;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS[webhook];

  let lastError: N8nResult<T> = {
    ok: false,
    error: "Request was never attempted",
    retryable: false,
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-secret": secret,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        // n8n responses are never cacheable; they are commands, not documents.
        cache: "no-store",
      });

      if (!response.ok) {
        const retryable = response.status >= 500 || response.status === 429;
        lastError = {
          ok: false,
          status: response.status,
          retryable,
          error:
            response.status === 401 || response.status === 403
              ? "n8n rejected the shared secret. Check N8N_WEBHOOK_SECRET matches the workflow."
              : response.status === 404
                ? "The n8n workflow is not listening on that URL. Check the workflow is active."
                : `n8n returned ${response.status}.`,
        };
        if (!retryable || attempt === maxAttempts) return lastError;
        continue;
      }

      // n8n's "Respond Immediately" mode replies with an empty body, which is
      // valid and expected — do not treat unparseable JSON as a failure.
      const text = await response.text();
      const data = text ? (JSON.parse(text) as T) : ({} as T);
      return { ok: true, data };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      lastError = {
        ok: false,
        retryable: true,
        error: aborted
          ? `n8n did not respond within ${timeoutMs / 1000}s.`
          : "Could not reach n8n. Check the instance is up.",
      };
      if (attempt === maxAttempts) return lastError;
    } finally {
      clearTimeout(timer);
    }
  }

  return lastError;
}

/* ===========================================================================
 * Typed wrappers — one per operator action.
 *
 * Payload shapes are a contract with the n8n Webhook nodes. Every field name
 * below is deliberate; n8n reads them positionally by key, so a typo produces a
 * workflow run that succeeds and does nothing.
 * =========================================================================== */

/**
 * Situations 1 and 2: competitor added, or its frequencies changed.
 *
 * Same endpoint for both — `action: "upsert_competitor"` covers create and
 * update, which is also why this call is safe to retry.
 */
export function triggerConfigLoader(
  competitor: CompetitorPayload,
  signalConfigs: SignalConfigPayload[],
) {
  return callN8n(
    "configLoader",
    {
      action: "upsert_competitor",
      competitor,
      signal_configs: signalConfigs,
    },
    // Registering seven Apify schedules takes a moment; give it room.
    { timeoutMs: 25_000, attempts: 2 },
  );
}

/**
 * Situation 3: Run Now on one competitor + signal.
 *
 * Deliberately never retried. This spends money — it fires an Apify actor run
 * outside the schedule. After an ambiguous timeout the run may well have started,
 * so a retry risks a second billable run for one click. Surface the failure and
 * let the operator decide.
 */
export function triggerManualRun(
  competitor: Pick<CompetitorPayload, "id" | "name" | "url">,
  signalType: SignalType,
) {
  return callN8n("manualTrigger", {
    competitor_id: competitor.id,
    competitor_name: competitor.name,
    competitor_url: competitor.url,
    signal_type: signalType,
    triggered_by: "user_manual",
    timestamp: new Date().toISOString(),
  });
}

/**
 * Situation 4: digest refresh.
 *
 * n8n decides staleness, so the app's job is to report when it last saw a digest
 * and let the workflow choose. `lastDigestAt` is null on a first run — send null
 * rather than a fabricated date, so n8n can tell "never generated" from "old".
 *
 * The response is bimodal by design: a fresh digest comes straight back, while a
 * stale one kicks off WF-03. WF-03 takes minutes, which is far longer than the
 * app will wait — see the timeout note on TIMEOUT_MS.digest. A timeout here is
 * therefore not necessarily a failure; the result may still arrive via Realtime.
 */
export function triggerDigest(lastDigestAt: string | null, forceRefresh = false) {
  return callN8n("digest", {
    trigger: "user_login",
    last_digest_at: lastDigestAt,
    force_refresh: forceRefresh,
  });
}
