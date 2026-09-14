"use server";

import { requireUser } from "@/lib/dal";
import { isDigestStale } from "@/lib/digest";
import { enqueue, isQueueConfigured } from "@/lib/queue/intake";
import { createClient } from "@/lib/supabase/server";
import type { Digest } from "@/lib/types/database";

/**
 * The digest request path.
 *
 * The sequence is a lock protocol, not a fetch:
 *
 *   1. reap any lock left behind by a generate_digest run that died mid-flight
 *   2. read the newest digest and decide whether one is actually due
 *   3. INSERT status='generating' — the partial unique index makes "only one run
 *      at a time" a database guarantee rather than an application hope
 *   4. enqueue generate_digest — a direct insert into the worker's own queue,
 *      not an HTTP round trip, so there is no ambiguous timeout case the way
 *      an n8n webhook call had
 *   5. the worker PATCHes the lock row to 'ready'; the browser sees it over Realtime
 *
 * Step 4 never returns the digest. Anything that waits on this call for content
 * is misreading the design.
 */

/** Postgres unique_violation — someone else already holds the digest lock. */
const UNIQUE_VIOLATION = "23505";

export type DigestOutcome =
  /** A recent digest already exists. Nothing was called. */
  | "fresh"
  /** A run is in flight. Wait for Realtime; do not call again. */
  | "generating"
  /** We took the lock and the job was queued. */
  | "requested"
  /** The queue could not be reached or is not configured. No run is happening. */
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

  // A generate_digest run that dies without writing 'ready' leaves 'generating'
  // behind forever, and every future request is then rejected by the unique
  // index. Clearing that first is why the reaper exists — 15 minutes is its default.
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

  if (!isQueueConfigured()) {
    return { outcome: "unavailable", digest: ready, error: "The pipeline queue is not configured." };
  }

  // Take the lock before enqueuing, never after. The window between "job
  // queued" and "row inserted" is exactly where duplicate Opus 5 runs live.
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

  // enqueue() is a direct database insert, not an HTTP round trip — it either
  // queues the job or throws. There is no ambiguous timeout case the way an
  // n8n webhook call had, so a failure here is always definitively rejected:
  // release the lock immediately rather than waiting for the 15-minute reaper.
  try {
    const jobId = await enqueue("generate_digest", { digestId: lockRow.id }, { singletonKey: lockRow.id });
    if (!jobId) {
      throw new Error("generate_digest was already queued for this digest.");
    }
    return { outcome: "requested", digest: lockRow, error: null };
  } catch (error) {
    await supabase.rpc("reap_stale_digests", { max_age: "0 seconds" });
    return {
      outcome: "unavailable",
      digest: ready,
      error: error instanceof Error ? error.message : "Could not queue the digest job.",
    };
  }
}
