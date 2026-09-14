"use server";

import { revalidatePath } from "next/cache";

import { requireUser } from "@/lib/dal";
import { triggerConfigLoader, type SignalConfigPayload } from "@/lib/n8n";
import { DEFAULT_FREQUENCY_HOURS, SIGNAL_TYPES, type SignalType } from "@/lib/signals";
import { createClient } from "@/lib/supabase/server";

export interface CompetitorActionState {
  ok: boolean;
  /** Hard failure — nothing was saved. */
  error: string | null;
  /**
   * Saved to Supabase, but the n8n hand-off did not land. The competitor exists
   * and is editable; it simply is not scheduled in Apify yet.
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
 * Push a competitor's full desired config to n8n.
 *
 * The Config Loader contract sends *all seven* signal configs every time, not a
 * delta — n8n reconciles the whole set against Apify. So this reads current state
 * back out of Supabase rather than trusting the caller to assemble it.
 */
async function pushConfigToN8n(
  competitorId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient();

  const [{ data: competitor, error: cErr }, { data: configs, error: sErr }] =
    await Promise.all([
      supabase
        .from("competitors")
        .select("id, name, url")
        .eq("id", competitorId)
        .single(),
      supabase
        .from("signal_configs")
        .select("signal_type, frequency_hours, enabled")
        .eq("competitor_id", competitorId),
    ]);

  if (cErr || !competitor) {
    return { ok: false, error: cErr?.message ?? "Competitor not found." };
  }
  if (sErr || !configs) {
    return { ok: false, error: sErr?.message ?? "Could not read signal configs." };
  }

  const payload: SignalConfigPayload[] = configs.map((c) => ({
    signal_type: c.signal_type as SignalType,
    frequency_hours: c.frequency_hours,
    enabled: c.enabled,
  }));

  const result = await triggerConfigLoader(
    {
      id: competitor.id,
      name: competitor.name,
      url: competitor.url,
      // n8n expects both; they carry the same value today.
      brand_name: competitor.name,
    },
    payload,
  );

  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/**
 * Add a competitor and seed its seven signals.
 *
 * Order matters, and the failure mode is deliberate: Supabase first, n8n second.
 * If the n8n hand-off fails we keep the competitor and report a warning rather
 * than rolling back — a competitor that exists but is not yet scheduled is
 * recoverable with one click, whereas losing the operator's typed input to a
 * transient webhook timeout is not.
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

  const pushed = await pushConfigToN8n(competitor.id);
  revalidatePath("/competitors");

  return {
    ok: true,
    error: null,
    warning: pushed.ok
      ? null
      : `${name} was saved, but n8n did not accept the schedule request: ${pushed.error} — use Sync to retry.`,
  };
}

/** Change one signal's cadence or on/off state, then re-push the whole set. */
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

  const pushed = await pushConfigToN8n(competitorId);
  revalidatePath("/competitors");

  return {
    ok: true,
    error: null,
    warning: pushed.ok
      ? null
      : `Saved, but n8n did not accept the change: ${pushed.error} — use Sync to retry.`,
  };
}

/** Retry the n8n hand-off for a competitor whose schedules never registered. */
export async function syncCompetitor(competitorId: string): Promise<CompetitorActionState> {
  await requireUser();

  const pushed = await pushConfigToN8n(competitorId);
  revalidatePath("/competitors");

  return pushed.ok
    ? { ok: true, error: null, warning: null }
    : { ...EMPTY, error: pushed.error };
}

/**
 * Pause or resume a competitor.
 *
 * This is the everyday alternative to deleting. A hard delete is blocked by a
 * database trigger while any Apify schedule is still registered, because the
 * cascade would destroy the schedule ids n8n needs in order to cancel them —
 * leaving the schedules running, scraping and billing with nothing pointing at
 * them. See supabase/03-ownership-hardening.sql.
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

  revalidatePath("/competitors");
  return { ok: true, error: null, warning: null };
}
