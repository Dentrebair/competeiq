import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { BrandProfile } from "@/lib/types/database";

/**
 * The operator's own business, as context for every Claude call.
 *
 * Without this, every recommendation in the product is reasoning about the
 * operator's position purely from their competitor's website — which is how you
 * end up asserting "high impact on first-time buyers" for a brand whose customer
 * mix nothing in the system has ever seen.
 *
 * Callers must have already established the operator's identity through
 * `requireUser()` / `requireUserOrRespond()`. This module reads through the
 * request-scoped Supabase client, so RLS is a live backstop either way, but the
 * authorization decision belongs at the entry point — see lib/dal.ts.
 */

/** The single profile row, or null before onboarding has run. */
export async function readBrandProfile(): Promise<BrandProfile | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("brand_profile")
    .select("*")
    .limit(1)
    .maybeSingle();

  // A missing profile is a normal state, not an error — the app works without
  // one, it just reasons less well. Anything else is worth surfacing in logs.
  if (error) {
    console.error("[brand-profile] read failed:", error.message);
    return null;
  }

  return (data as BrandProfile | null) ?? null;
}

function formatPriceBand(profile: BrandProfile): string | null {
  const { price_min, price_max, currency } = profile;
  if (typeof price_min !== "number" || typeof price_max !== "number") return null;
  const unit = currency ? `${currency} ` : "";
  return `${unit}${price_min.toFixed(2)}–${unit}${price_max.toFixed(2)}`;
}

/**
 * How certain the catalogue figures are, in words Claude should act on.
 *
 * This matters more than it looks. At `inferred` the product count and price band
 * were read off marketing copy, and a recommendation that leans hard on "your
 * £24 price point" is then built on a guess. Saying so in the prompt is what
 * stops the model treating all three tiers as equally solid.
 */
const CATALOGUE_CAVEAT: Record<string, string> = {
  confirmed:
    "The catalogue figures below come directly from the brand's own product feed. Treat them as fact.",
  page_data:
    "The catalogue figures below were read from a sample of the brand's product pages. They are close but may be incomplete — do not treat a price band as exhaustive.",
  inferred:
    "The catalogue figures below were INFERRED from reading the brand's website, not from a product feed. They may be wrong. Do not build a recommendation on a specific price or product count without saying that you are assuming it.",
  described:
    "This business has no website yet. There is no catalogue at all — categories, audience and positioning below come from the operator's own description, not from anything read or verified.",
};

/**
 * Render the profile as a prompt block.
 *
 * Returns null when there is no profile, so callers can omit the section
 * entirely rather than sending "unknown" a dozen times — a wall of "unknown"
 * reads to the model as meaningful absence and invites it to fill the gaps.
 *
 * Where this goes in a request matters: put it in the USER message, never in a
 * cached system prompt. It changes whenever the operator edits their profile or
 * the store is re-read, and volatile content inside a cached prefix invalidates
 * the cache on every change while looking like it is working.
 */
export function brandProfileContext(profile: BrandProfile | null): string | null {
  if (!profile) return null;

  const lines: string[] = [];

  lines.push("<brand_profile>");
  lines.push(
    "This is the business you are advising. Every recommendation is for them, not for a generic retailer.",
  );
  lines.push("");

  if (profile.name) lines.push(`Brand: ${profile.name}`);
  lines.push(profile.url ? `Store: ${profile.url}` : "Store: none — this business has no website yet.");
  if (profile.platform && profile.platform !== "none") lines.push(`Platform: ${profile.platform}`);

  const caveat = profile.catalogue_source
    ? CATALOGUE_CAVEAT[profile.catalogue_source]
    : null;
  if (caveat) {
    lines.push("");
    lines.push(caveat);
  }

  if (profile.categories.length) {
    lines.push(`Categories: ${profile.categories.join(", ")}`);
  }
  if (typeof profile.product_count === "number") {
    lines.push(`Products: ${profile.product_count}`);
  }
  const band = formatPriceBand(profile);
  if (band) lines.push(`Price range: ${band}`);

  // Always inferred, at every tier — no storefront publishes machine-readable
  // positioning. Labelled so the model weighs it accordingly.
  if (profile.audience || profile.positioning) {
    lines.push("");
    lines.push("The following two are inferred from the site, not stated by the brand:");
    if (profile.audience) lines.push(`Audience: ${profile.audience}`);
    if (profile.positioning) lines.push(`Positioning: ${profile.positioning}`);
  }

  // The operator's own words outrank everything above — this is the one part
  // nothing was guessed from.
  if (profile.priorities) {
    lines.push("");
    lines.push(`Stated priorities, in the operator's own words: ${profile.priorities}`);
  }
  if (profile.notes) {
    lines.push(`Operator notes: ${profile.notes}`);
  }

  lines.push("</brand_profile>");

  return lines.join("\n");
}

/**
 * Convenience for the common case: read and render in one call.
 *
 * Returns a string that is safe to interpolate into a prompt whether or not a
 * profile exists — empty string when there is none.
 */
export async function brandContextBlock(): Promise<string> {
  const profile = await readBrandProfile();
  const block = brandProfileContext(profile);
  return block ? `${block}\n\n` : "";
}
