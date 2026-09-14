/**
 * The signal vocabulary — one set of strings for the whole system.
 *
 * Deliberately has NO "server-only" marker and no imports. Both the browser feed
 * and the server-side n8n layer need these strings, so they cannot live in a
 * server-only module: importing one from a Client Component is a build error, and
 * `lib/types/database.ts` is reachable from `lib/supabase/client.ts`.
 *
 * Keep this file free of anything that touches secrets, `process.env`, or Node
 * APIs, or that constraint quietly stops holding.
 *
 * There is exactly one vocabulary. The value in a `signal_configs` row is the
 * same string that lands in `alerts.signal_type` when that monitoring fires —
 * no translation between "what we monitor" and "what happened".
 *
 * These strings are a wire contract with n8n's Config Loader, which maps each to
 * an Apify actor and a cron expression. Renaming one here silently stops that
 * signal being scheduled, with no error on either side.
 */

export const SIGNAL_TYPES = [
  "sku_price_change",
  "catalog_change",
  "promo_discount",
  "ad_creative",
  "review_sentiment",
  "website_change",
  "newsletter",
] as const;

export type SignalType = (typeof SIGNAL_TYPES)[number];

const KNOWN = new Set<string>(SIGNAL_TYPES);

/**
 * Whether a raw database value is one of the seven known signal types.
 *
 * `alerts.signal_type` is `text`, not an enum, so a legacy row or a workflow
 * change can put something unexpected there. Guard with this before indexing
 * into a label or icon map — a bare lookup returns undefined and renders as a
 * blank cell with no clue why.
 */
export function isKnownSignalType(raw: string): raw is SignalType {
  return KNOWN.has(raw);
}

/** Human-readable labels, keyed by the wire strings so they cannot drift. */
export const SIGNAL_TYPE_LABELS: Record<SignalType, string> = {
  sku_price_change: "Price change",
  catalog_change: "Catalog change",
  promo_discount: "Promotion",
  ad_creative: "Ad creative",
  review_sentiment: "Review sentiment",
  website_change: "Website change",
  newsletter: "Newsletter",
};

/** Label for display, falling back to the raw string rather than blank. */
export function signalTypeLabel(raw: string): string {
  return isKnownSignalType(raw) ? SIGNAL_TYPE_LABELS[raw] : raw;
}

/**
 * Which signals the pipeline can actually deliver today.
 *
 * `signal_configs` records what the operator *asked* to monitor. That is not the
 * same as what any workflow can produce: WF-02 emits alerts from exactly three
 * diff branches — Diff Price, Diff Catalog and Diff Promo — so four of the seven
 * signals have nothing behind them however the toggles are set.
 *
 * Offering a live toggle for those is worse than offering none. It reads as
 * coverage, the grid then shows a row of quiet days, and the operator concludes
 * their rivals are doing nothing on a surface nobody is watching.
 *
 * This is the single source of truth for that: the Competitors screen disables
 * the toggle, and the Overview grid hatches the row. Flip an entry to "live" in
 * the same commit as the workflow branch that services it, never before.
 */
export const SIGNAL_AVAILABILITY: Record<SignalType, "live" | "coming_soon"> = {
  sku_price_change: "live",
  catalog_change: "live",
  promo_discount: "live",
  // Verified against wf-02-signal-processor.json: no diff branch produces these.
  website_change: "coming_soon",
  ad_creative: "coming_soon",
  review_sentiment: "coming_soon",
  newsletter: "coming_soon",
};

export function isSignalLive(signal: SignalType): boolean {
  return SIGNAL_AVAILABILITY[signal] === "live";
}

/**
 * Default cadence per signal, in hours. Matches the Config Loader example
 * payload — used when seeding a newly added competitor.
 */
export const DEFAULT_FREQUENCY_HOURS: Record<SignalType, number> = {
  sku_price_change: 3,
  catalog_change: 24,
  promo_discount: 3,
  ad_creative: 8,
  review_sentiment: 24,
  website_change: 8,
  newsletter: 24,
};

/** Bounds enforced by the signal_configs CHECK constraint. */
export const MIN_FREQUENCY_HOURS = 1;
export const MAX_FREQUENCY_HOURS = 168;
