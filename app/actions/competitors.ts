"use server";

import { revalidatePath } from "next/cache";

import { requireUser } from "@/lib/dal";
import { enqueue, isQueueConfigured, setSchedule, clearSchedule } from "@/lib/queue/intake";
import { scheduleFor } from "@/lib/scheduling";
import { DEFAULT_FREQUENCY_HOURS, SIGNAL_TYPES, type SignalType } from "@/lib/signals";
import { createClient } from "@/lib/supabase/server";

export interface CompetitorActionState {
  ok: boolean;
  /** Hard failure — nothing was saved. */
  error: string | null;
  /**
   * Saved to Supabase, but the schedule sync did not land. The competitor
   * exists and is editable; it simply is not scheduled to scrape yet.
   */
  warning: string | null;
}

const EMPTY: CompetitorActionState = { ok: false, error: null, warning: null };

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * Derive a bare domain from a URL, so the operator only has to paste one thing.
 * Returns null when the input is not parseable as a URL.
 */
function deriveDomain(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl.includes("://") ? rawUrl : `https://${rawUrl}`);
    return parsed.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Reconcile a competitor's pg-boss schedule with its current desired state —
 * replaces n8n's Config Loader (ADR-0005). Always reads the competitor's full
 * current state back out of Supabase rather than trusting the caller, since
 * "should this be scheduled, and how often" depends on all seven signals plus
 * `active`, not just whatever one field just changed.
 *
 * One schedule per competitor (not one per signal, unlike n8n's Apify
 * Schedules) — a single scrape produces price, catalog and promo signals
 * together, so there is nothing to gain from scheduling them separately.
 */
async function syncCompetitorSchedule(
  competitorId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isQueueConfigured()) {
    return { ok: false, error: "The pipeline queue is not configured." };
  }

  const supabase = await createClient();

  const [{ data: competitor, error: cErr }, { data: configs, error: sErr }] = await Promise.all([
    supabase.from("competitors").select("id, active").eq("id", competitorId).single(),
    supabase
      .from("signal_configs")
      .select("signal_type, frequency_hours, enabled")
      .eq("competitor_id", competitorId),
  ]);

  if (cErr || !competitor) {
    const message = cErr?.message ?? "Competitor not found.";
    console.error(JSON.stringify({ event: "sync_schedule_failed", competitorId, stage: "read_competitor", error: message }));
    return { ok: false, error: message };
  }
  if (sErr || !configs) {
    const message = sErr?.message ?? "Could not read signal configs.";
    console.error(JSON.stringify({ event: "sync_schedule_failed", competitorId, stage: "read_configs", error: message }));
    return { ok: false, error: message };
  }

  try {
    const schedule = scheduleFor(
      competitor.active,
      configs.map((c) => ({
        signal_type: c.signal_type as SignalType,
        frequency_hours: c.frequency_hours,
        enabled: c.enabled,
      })),
    );

    if (schedule) {
      await setSchedule(
        "start_scrape",
        competitorId,
        schedule.cron,
        { competitorId },
        { singletonKey: competitorId },
      );
    } else {
      await clearSchedule("start_scrape", competitorId);
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not sync the schedule.";
    console.error(JSON.stringify({ event: "sync_schedule_failed", competitorId, stage: "queue_write", error: message }));
    return { ok: false, error: message };
  }
}

/**
 * Add a competitor and seed its seven signals.
 *
 * Order matters, and the failure mode is deliberate: Supabase first, the
 * schedule sync second. If the sync fails we keep the competitor and report a
 * warning rather than rolling back — a competitor that exists but is not yet
 * scheduled is recoverable with one click (Sync), whereas losing the
 * operator's typed input to a transient queue error is not.
 */
export async function addCompetitor(
  _prev: CompetitorActionState,
  formData: FormData,
): Promise<CompetitorActionState> {
  await requireUser();

  const name = String(formData.get("name") ?? "").trim();
  const rawUrl = String(formData.get("url") ?? "").trim();

  if (!name || !rawUrl) {
    return { ...EMPTY, error: "Name and URL are both required." };
  }

  const domain = deriveDomain(rawUrl);
  if (!domain) {
    return { ...EMPTY, error: `"${rawUrl}" is not a valid URL.` };
  }

  // Normalise so the stored URL always has a scheme.
  const url = rawUrl.includes("://") ? rawUrl : `https://${rawUrl}`;

  const supabase = await createClient();

  const { data: competitor, error } = await supabase
    .from("competitors")
    .insert({ name, domain, url })
    .select("id")
    .single();

  if (error || !competitor) {
    if (error?.code === UNIQUE_VIOLATION) {
      return { ...EMPTY, error: `${domain} is already being monitored.` };
    }
    return { ...EMPTY, error: error?.message ?? "Could not save that competitor." };
  }

  const { error: seedError } = await supabase.from("signal_configs").insert(
    SIGNAL_TYPES.map((signalType) => ({
      competitor_id: competitor.id,
      signal_type: signalType,
      frequency_hours: DEFAULT_FREQUENCY_HOURS[signalType],
      enabled: true,
    })),
  );

  if (seedError) {
    return {
      ok: true,
      error: null,
      warning: `${name} was saved, but its signals could not be created: ${seedError.message}`,
    };
  }

  const synced = await syncCompetitorSchedule(competitor.id);
  revalidatePath("/competitors");

  return {
    ok: true,
    error: null,
    warning: synced.ok
      ? null
      : `${name} was saved, but the schedule could not be set: ${synced.error} — use Sync to retry.`,
  };
}

/** Change one signal's cadence or on/off state, then resync the competitor's schedule. */
export async function updateSignalConfig(
  competitorId: string,
  signalType: SignalType,
  patch: { frequency_hours?: number; enabled?: boolean },
): Promise<CompetitorActionState> {
  await requireUser();

  const supabase = await createClient();
  const { error } = await supabase
    .from("signal_configs")
    .update(patch)
    .eq("competitor_id", competitorId)
    .eq("signal_type", signalType);

  if (error) {
    return { ...EMPTY, error: error.message };
  }

  const synced = await syncCompetitorSchedule(competitorId);
  revalidatePath("/competitors");

  return {
    ok: true,
    error: null,
    warning: synced.ok ? null : `Saved, but the schedule could not be updated: ${synced.error} — use Sync to retry.`,
  };
}

/** Retry the schedule sync for a competitor whose schedule never registered. */
export async function syncCompetitor(competitorId: string): Promise<CompetitorActionState> {
  await requireUser();

  const synced = await syncCompetitorSchedule(competitorId);
  revalidatePath("/competitors");

  return synced.ok
    ? { ok: true, error: null, warning: null }
    : { ...EMPTY, error: synced.error };
}

/**
 * Pause or resume a competitor.
 *
 * This is the everyday alternative to deleting — there is no delete button,
 * deliberately (see components/competitors/monitoring.tsx). Pausing clears
 * the pg-boss schedule immediately rather than waiting for a manual Sync,
 * since the entire point of pausing is that scraping stops now.
 */
export async function setCompetitorActive(
  competitorId: string,
  active: boolean,
): Promise<CompetitorActionState> {
  await requireUser();

  const supabase = await createClient();
  const { error } = await supabase
    .from("competitors")
    .update({ active })
    .eq("id", competitorId);

  if (error) {
    return { ...EMPTY, error: error.message };
  }

  const synced = await syncCompetitorSchedule(competitorId);
  revalidatePath("/competitors");

  return {
    ok: true,
    error: null,
    warning: synced.ok
      ? null
      : `${active ? "Resumed" : "Paused"}, but the schedule could not be updated: ${synced.error} — use Sync to retry.`,
  };
}

/**
 * Run Now — replaces n8n's Manual Trigger. Enqueues the same start_scrape job
 * the competitor's own schedule would fire, immediately.
 *
 * Deliberately not deduped beyond the queue's own "short" policy (at most one
 * start_scrape waiting per competitor) — a second click while one is already
 * queued collapses harmlessly rather than erroring.
 */
export async function runCompetitorNow(competitorId: string): Promise<CompetitorActionState> {
  await requireUser();

  if (!isQueueConfigured()) {
    return { ...EMPTY, error: "The pipeline queue is not configured." };
  }

  try {
    await enqueue("start_scrape", { competitorId }, { singletonKey: competitorId });
    return { ok: true, error: null, warning: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not queue the scrape.";
    console.error(JSON.stringify({ event: "run_competitor_now_failed", competitorId, error: message }));
    return { ...EMPTY, error: message };
  }
}

/**
 * Hard delete. The everyday action is still pausing (setCompetitorActive) —
 * this is for when a competitor was added by mistake or is gone for good.
 *
 * Schedule cleared first, deliberately: a delete that races a queued
 * start_scrape would otherwise leave an orphaned schedule cron-ing forever
 * against a competitor id that no longer resolves (see CLAUDE.md, "Who owns
 * which column"). alerts.competitor_id and competitor_products cascade
 * correctly as of supabase/11-run-progress-and-delete.sql — alerts survive
 * with competitor_id set to null (they keep their own competitor_name),
 * everything else the worker owns is deleted along with the competitor.
 */
export async function deleteCompetitor(competitorId: string): Promise<CompetitorActionState> {
  await requireUser();

  if (isQueueConfigured()) {
    try {
      await clearSchedule("start_scrape", competitorId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not clear the schedule.";
      console.error(JSON.stringify({ event: "delete_competitor_clear_schedule_failed", competitorId, error: message }));
      return { ...EMPTY, error: `Could not clear the schedule before deleting: ${message}` };
    }
  }

  const supabase = await createClient();
  const { error } = await supabase.from("competitors").delete().eq("id", competitorId);

  if (error) {
    console.error(JSON.stringify({ event: "delete_competitor_failed", competitorId, error: error.message }));
    return { ...EMPTY, error: error.message };
  }

  revalidatePath("/competitors");
  return { ok: true, error: null, warning: null };
}
