"use server";

import { requireUser } from "@/lib/dal";
import { isDigestStale } from "@/lib/digest";
import { triggerDigest } from "@/lib/n8n";
import { createClient } from "@/lib/supabase/server";
import type { Digest } from "@/lib/types/database";

/**
 * The digest request path.
 *
 * The sequence is a lock protocol, not a fetch:
 *
 *   1. reap any lock left behind by a WF-03 run that died mid-flight
 *   2. read the newest digest and decide whether one is actually due
 *   3. INSERT status='generating' — the partial unique index makes "only one run
 *      at a time" a database guarantee rather than an application hope
 *   4. POST the Digest webhook, which answers 202 and keeps working
 *   5. WF-03 PATCHes the lock row to 'ready'; the browser sees it over Realtime
 *
 * Step 4 never returns the digest. Anything that waits on this call for content
 * is misreading the design — see the timeout note in lib/n8n.ts.
 */

/** Postgres unique_violation — someone else already holds the digest lock. */
const UNIQUE_VIOLATION = "23505";

export type DigestOutcome =
  /** A recent digest already exists. Nothing was called. */
  | "fresh"
  /** A run is in flight. Wait for Realtime; do not call again. */
  | "generating"
  /** We took the lock and n8n accepted the job. */
  | "requested"
  /** n8n could not be reached or is not configured. No run is happening. */
  | "unavailable";

export interface DigestRequestResult {
  outcome: DigestOutcome;
  /** The row the UI should render — the in-flight lock, or the last good digest. */
  digest: Digest | null;
  /** Set on "unavailable", and on "generating" when the webhook answer was ambiguous. */
  error: string | null;
}

type Client = Awaited<ReturnType<typeof createClient>>;

/** The newest row of any status — this is what the panel renders. */
async function latestDigest(supabase: Client): Promise<Digest | null> {
  const { data } = await supabase
    .from("digests")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return (data as Digest | null) ?? null;
}

/** The newest *completed* digest — what staleness is measured against. */
async function latestReadyDigest(supabase: Client): Promise<Digest | null> {
  const { data } = await supabase
    .from("digests")
    .select("*")
    .eq("status", "ready")
    .order("generated_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  return (data as Digest | null) ?? null;
}

/**
 * Read the current digest without triggering anything.
 *
 * Used by the dashboard's server render, so the operator sees this morning's
 * briefing on first paint rather than a spinner that resolves into it.
 */
export async function readLatestDigest(): Promise<Digest | null> {
  await requireUser();
  const supabase = await createClient();
  return latestDigest(supabase);
}

/**
 * Ask for a digest, generating one only if it is genuinely due.
 *
 * `force` skips the staleness check but not the lock — an operator hammering
 * Refresh cannot start a second Opus 5 run.
 */
export async function requestDigest(force = false): Promise<DigestRequestResult> {
  await requireUser();
  const supabase = await createClient();

  // A WF-03 run that dies without PATCHing leaves 'generating' behind forever,
  // and every future request is then rejected by the unique index. Clearing that
  // first is why the reaper exists — 15 minutes is its default.
  await supabase.rpc("reap_stale_digests", {});

  const latest = await latestDigest(supabase);

  if (latest?.status === "generating") {
    return { outcome: "generating", digest: latest, error: null };
  }

  // `latest` may be a 'failed' row, which says nothing about how old the last
  // real digest is. Staleness is measured against the last 'ready' one.
  const ready = latest?.status === "ready" ? latest : await latestReadyDigest(supabase);

  if (!force && !isDigestStale(ready)) {
    return { outcome: "fresh", digest: ready, error: null };
  }

  // Take the lock before calling n8n, never after. The window between "webhook
  // accepted" and "row inserted" is exactly where duplicate Opus 5 runs live.
  const { data: lock, error: lockError } = await supabase
    .from("digests")
    .insert({ status: "generating" })
    .select("*")
    .single();

  if (lockError || !lock) {
    if (lockError?.code === UNIQUE_VIOLATION) {
      // Another tab or a racing click got there first. That run's result reaches
      // this browser over Realtime too, so there is nothing to do but wait.
      return { outcome: "generating", digest: await latestDigest(supabase), error: null };
    }
    return {
      outcome: "unavailable",
      digest: ready,
      error: lockError?.message ?? "Could not take the digest lock.",
    };
  }

  const lockRow = lock as Digest;

  // Sent as diagnostic context only. WF-03 does not branch on it — the app has
  // already decided, above, that a run is warranted.
  const result = await triggerDigest(ready?.generated_at ?? null, force);

  if (result.ok) {
    return { outcome: "requested", digest: lockRow, error: null };
  }

  /*
    Releasing the lock is the subtle part.

    A 4xx/5xx or a configuration error means n8n definitively did not take the
    job: hold the lock and the panel spins for 15 minutes over a typo'd URL. So
    reap it immediately — the partial unique index guarantees the only
    'generating' row in existence is the one we just inserted, which is what
    makes a zero-age reap safe here.

    A timeout or a connection error is NOT the same thing. WF-03 answers 202 and
    then works for minutes; an aborted fetch may well have started a real run.
    Releasing there would strand the digest, because WF-03 PATCHes
    `?status=eq.generating` and would match nothing. Keep the lock and let the
    normal 15-minute reaper decide.
  */
  const definitivelyRejected = typeof result.status === "number" || !result.retryable;

  if (definitivelyRejected) {
    await supabase.rpc("reap_stale_digests", { max_age: "0 seconds" });
    return { outcome: "unavailable", digest: ready, error: result.error };
  }

  return { outcome: "generating", digest: lockRow, error: result.error };
}
