/**
 * Free-tier guardrails, protecting the Apify free plan's budget.
 *
 * No "server-only" marker and no imports — same reasoning as lib/signals.ts:
 * the Pricing page and the Competitors screen both need these numbers in the
 * browser bundle to explain *why* a limit is showing, not just enforce it.
 *
 * These only take effect once `pipeline_state.mode` is `live` — see
 * lib/pipeline-mode.ts. While `paused` (the default, and where a fresh
 * install starts), nothing here is enforced, so manual testing is never
 * throttled by limits meant for unattended production use.
 */

/** Total competitors that can be monitored at once. */
export const FREE_TIER_MAX_COMPETITORS = 2;

/** Products scraped per competitor per run (worker/handlers/start-scrape.ts). */
export const FREE_TIER_MAX_PRODUCTS_PER_COMPETITOR = 5;

/** The slowest a competitor's automated schedule is allowed to run — weekly. */
export const FREE_TIER_CADENCE_HOURS = 168;

/** Minimum time between "Run Now" clicks for the same competitor. */
export const FREE_TIER_RUN_NOW_COOLDOWN_HOURS = 24;
