"use server";

import { revalidatePath } from "next/cache";

import { addCompetitor } from "@/app/actions/competitors";
import {
  ANALYSIS_MODEL,
  anthropic,
  isAnthropicConfigured,
  textFromMessage,
} from "@/lib/anthropic";
import { requireUser } from "@/lib/dal";
import {
  fetchPageText,
  isMonitorable,
  normaliseStoreUrl,
  readStore,
  type CatalogueSource,
  type StoreRead,
} from "@/lib/store-reader";
import { createClient } from "@/lib/supabase/server";
import type { BrandProfile, CompetitorSuggestion } from "@/lib/types/database";

/**
 * Onboarding: learn the operator's business from one URL, then propose
 * competitors worth monitoring.
 *
 * This replaces the profile form nobody fills in. The catalogue is read from the
 * store itself (lib/store-reader.ts), the softer things are inferred, and the
 * operator confirms — a thirty-second review rather than ten empty fields.
 *
 * The tier the read landed on travels with the data all the way into the
 * database, because it changes what everything downstream is entitled to assert.
 * At `confirmed` the price band is fact; at `inferred` it is a guess, and a
 * recommendation built on it needs to say so.
 */

export interface BrandProfileDraft {
  url: string;
  name: string | null;
  platform: string;
  catalogueSource: CatalogueSource;
  categories: string[];
  productCount: number | null;
  priceMin: number | null;
  priceMax: number | null;
  currency: string | null;
  audience: string | null;
  positioning: string | null;
  /** What the read did, in one line. Belongs on the review screen. */
  note: string;
}

export type DraftResult =
  | { ok: true; draft: BrandProfileDraft }
  | { ok: false; error: string };

/**
 * Cleaned-up interpretation of a store.
 *
 * `categories` is regenerated rather than passed through, and that is not
 * cosmetic. A real Shopify feed hands back tags like "Website Exclusive Sale",
 * "National Coffee Day" and "Merch" mixed in with genuine product categories —
 * verified on a live store while building this. Writing that list into the
 * profile means every later prompt reasons about "National Coffee Day" as though
 * it were a product line.
 */
const INTERPRETATION_SCHEMA = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description:
        "The brand's name as customers would say it. If the provided name is already clean, return it unchanged.",
    },
    categories: {
      type: "array",
      maxItems: 8,
      items: { type: "string" },
      description:
        "Real product categories only — what the brand sells. Discard promotional tags, seasonal campaign names, collection labels and merchandising flags from the candidate list. Prefer the words the brand itself uses. Empty array if the input does not support any.",
    },
    audience: {
      type: "string",
      description:
        "One sentence on who buys from this brand, inferred from its range, prices and language. Say 'Unclear from the available data' rather than guessing when there is little to go on.",
    },
    positioning: {
      type: "string",
      description:
        "One or two sentences on how the brand positions itself — premium, value, specialist, mass-market — and what it competes on besides price.",
    },
  },
  required: ["name", "categories", "audience", "positioning"],
  additionalProperties: false,
} as const;

const INTERPRETATION_SYSTEM = `You read ecommerce storefront data and describe the business behind it.

You are given whatever could be read from a store — sometimes a full product feed,
sometimes a handful of product pages, sometimes only the text of the homepage.
Work from what is there.

Two rules:

- Do not invent. If the input does not tell you who the customer is, say it is
  unclear. A confident guess is worse than an admission, because everything
  downstream treats your answer as the brand's own description of itself.
- Separate products from promotions. Category candidates taken from a store's own
  tags are full of campaign names, sale flags and collection labels. Keep only
  what the brand actually sells.`;

/** What the model gets to look at, assembled from whichever tier answered. */
async function interpretationInput(read: StoreRead): Promise<string> {
  const lines: string[] = [];

  lines.push(`Store: ${read.url}`);
  lines.push(`Platform: ${read.platform}`);
  lines.push(`How this was read: ${read.source ?? "no machine-readable catalogue"}`);
  if (read.name) lines.push(`Name given by the platform: ${read.name}`);
  if (read.description) lines.push(`The store's own description: ${read.description}`);
  if (typeof read.productCount === "number") lines.push(`Products: ${read.productCount}`);
  if (read.priceMin !== null && read.priceMax !== null) {
    const unit = read.currency ? `${read.currency} ` : "";
    lines.push(`Prices seen: ${unit}${read.priceMin} to ${unit}${read.priceMax}`);
  }
  if (read.categories.length) {
    lines.push(`Category candidates (unfiltered, includes promotional tags): ${read.categories.join(", ")}`);
  }
  if (read.sampleTitles.length) {
    lines.push(`Sample products: ${read.sampleTitles.join(" · ")}`);
  }

  // Nothing structured came back, so read the homepage instead. Deliberately a
  // plain fetch rather than a web-search tool: one request, no tool loop, and
  // the call stays constrained to a JSON schema.
  if (!read.source) {
    const text = await fetchPageText(read.url);
    if (text) {
      lines.push("");
      lines.push("No catalogue could be read. Homepage text follows — infer from it:");
      lines.push(text);
    }
  }

  return lines.join("\n");
}

/**
 * Read a store and produce a draft profile. Saves nothing.
 *
 * Nothing is written until the operator confirms on the review screen — at the
 * lower tiers a fair amount of this is inference, and inference the user never
 * saw is how a product ends up confidently wrong about its own customer.
 */
export async function readStoreDraft(rawUrl: string): Promise<DraftResult> {
  await requireUser();

  const origin = normaliseStoreUrl(rawUrl);
  if (!origin) {
    return { ok: false, error: `"${rawUrl}" does not look like a web address.` };
  }

  const read = await readStore(origin.origin);
  if (!read) {
    return { ok: false, error: `"${rawUrl}" does not look like a web address.` };
  }

  // No answer at all — a typo, or a site that is down. Either way there is
  // nothing to review, so stop here rather than offering an empty draft.
  if (!read.reachable) {
    return { ok: false, error: read.note };
  }

  const base: BrandProfileDraft = {
    url: read.url,
    name: read.name,
    platform: read.platform,
    catalogueSource: read.source ?? "inferred",
    categories: read.categories,
    productCount: read.productCount,
    priceMin: read.priceMin,
    priceMax: read.priceMax,
    currency: read.currency,
    audience: null,
    positioning: null,
    note: read.note,
  };

  // Fails soft: without a key the operator gets the catalogue facts and fills in
  // the rest themselves. That is a worse review screen, not a broken one.
  if (!isAnthropicConfigured()) {
    return {
      ok: true,
      draft: {
        ...base,
        note: `${read.note} Audience and positioning were not filled in — ANTHROPIC_API_KEY is not set.`,
      },
    };
  }

  try {
    const message = await anthropic().messages.create({
      model: ANALYSIS_MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: INTERPRETATION_SCHEMA },
      },
      system: [
        { type: "text", text: INTERPRETATION_SYSTEM, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: await interpretationInput(read) }],
    });

    const text = textFromMessage(message);
    if (!text.ok) return { ok: true, draft: base };

    const parsed = JSON.parse(text.text) as {
      name: string;
      categories: string[];
      audience: string;
      positioning: string;
    };

    return {
      ok: true,
      draft: {
        ...base,
        name: parsed.name || base.name,
        categories: parsed.categories?.length ? parsed.categories : base.categories,
        audience: parsed.audience,
        positioning: parsed.positioning,
      },
    };
  } catch (error) {
    // The catalogue read already succeeded — losing the interpretation is a
    // degraded review screen, not a failed onboarding.
    console.error("[onboarding] interpretation failed:", error);
    return { ok: true, draft: base };
  }
}

/**
 * Save the reviewed draft. One row, updated in place.
 *
 * Read-then-write rather than an upsert on `singleton`: that column is not in the
 * app's INSERT grant (it exists only to enforce the one-row rule), and this way
 * there is no question about whether the conflict target needs to be present in
 * the payload.
 *
 * `priorities` and `notes` are never touched here — they are the operator's own
 * words, and re-reading the store must not overwrite them.
 */
export async function saveBrandProfile(
  draft: BrandProfileDraft,
): Promise<{ ok: boolean; error?: string }> {
  await requireUser();

  const supabase = await createClient();

  const fields = {
    url: draft.url,
    name: draft.name,
    platform: draft.platform,
    catalogue_source: draft.catalogueSource,
    categories: draft.categories,
    product_count: draft.productCount,
    price_min: draft.priceMin,
    price_max: draft.priceMax,
    currency: draft.currency,
    audience: draft.audience,
    positioning: draft.positioning,
    last_read_at: new Date().toISOString(),
  };

  const { data: existing } = await supabase.from("brand_profile").select("id").limit(1).maybeSingle();

  const { error } = existing
    ? await supabase.from("brand_profile").update(fields).eq("id", (existing as { id: string }).id)
    : await supabase.from("brand_profile").insert(fields);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/");
  revalidatePath("/competitors");
  return { ok: true };
}

/* ==========================================================================
 * Competitor suggestions
 * ========================================================================== */

const CANDIDATE_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            description: "Bare domain, no scheme and no www. e.g. bonescoffee.com",
          },
          name: { type: "string" },
          rationale: {
            type: "string",
            description:
              "One sentence on why this brand competes with the operator's — what overlaps.",
          },
        },
        required: ["domain", "name", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["candidates"],
  additionalProperties: false,
} as const;

interface Candidate {
  domain: string;
  name: string;
  rationale: string;
}

/** The profile, condensed to what a competitor search needs. */
function profileBrief(profile: BrandProfile): string {
  const lines = [`Brand: ${profile.name ?? profile.url}`, `Store: ${profile.url}`];
  if (profile.categories.length) lines.push(`Sells: ${profile.categories.join(", ")}`);
  if (profile.price_min !== null && profile.price_max !== null) {
    const unit = profile.currency ? `${profile.currency} ` : "";
    lines.push(`Price range: ${unit}${profile.price_min}–${unit}${profile.price_max}`);
  }
  if (profile.audience) lines.push(`Audience: ${profile.audience}`);
  if (profile.positioning) lines.push(`Positioning: ${profile.positioning}`);
  return lines.join("\n");
}

/**
 * Propose competitors, then prove each one before offering it.
 *
 * Two model calls rather than one, deliberately. Finding competitors needs web
 * search; constraining an answer to a JSON schema is cleanest without tools in
 * play. So: search first and let it answer in prose, then extract that prose into
 * structure in a second, tool-free call. This runs once per install, so the extra
 * call costs nothing that matters.
 *
 * Then the part that actually determines whether a suggestion is worth showing:
 * every candidate is fetched. A model will produce a plausible domain that does
 * not resolve, or one that resolves to a blog. Only sites whose catalogue could
 * genuinely be read are stored — because an unmonitorable competitor does not
 * fail now, it fails silently in three days when no signals ever arrive.
 */
export async function suggestCompetitors(): Promise<{
  ok: boolean;
  suggestions?: CompetitorSuggestion[];
  error?: string;
  /** Candidates that were proposed but could not be verified. Worth surfacing. */
  rejected?: { domain: string; reason: string }[];
}> {
  await requireUser();

  if (!isAnthropicConfigured()) {
    return { ok: false, error: "Competitor suggestions need ANTHROPIC_API_KEY. You can still add competitors by hand." };
  }

  const supabase = await createClient();

  const [{ data: profileRow }, { data: existing }, { data: seen }] = await Promise.all([
    supabase.from("brand_profile").select("*").limit(1).maybeSingle(),
    supabase.from("competitors").select("domain"),
    supabase.from("competitor_suggestions").select("domain"),
  ]);

  const profile = profileRow as BrandProfile | null;
  if (!profile) {
    return { ok: false, error: "Read your store first — suggestions are based on what you sell." };
  }

  // Never re-propose something already monitored or already dismissed. A product
  // that keeps suggesting the site you rejected reads as not listening.
  const excluded = new Set<string>([
    profile.url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, ""),
    ...((existing ?? []) as { domain: string }[]).map((row) => row.domain),
    ...((seen ?? []) as { domain: string }[]).map((row) => row.domain),
  ]);

  const excludeLine = excluded.size
    ? `\n\nDo not propose any of these, they are already known: ${[...excluded].join(", ")}`
    : "";

  let prose: string;
  try {
    const search = await anthropic().messages.create({
      model: ANALYSIS_MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 6 }],
      messages: [
        {
          role: "user",
          content: `Find direct competitors for this ecommerce brand — other online stores selling comparable products to comparable customers.

${profileBrief(profile)}${excludeLine}

Look for brands that genuinely overlap on what they sell and who they sell to, not
merely the biggest names in the category. A giant marketplace is not a useful
competitor for a small brand.

Name up to eight, each with its website domain and one sentence on what overlaps.`,
        },
      ],
    });

    const text = textFromMessage(search);
    if (!text.ok) return { ok: false, error: text.error };
    prose = text.text;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return { ok: false, error: `Competitor search failed: ${detail}` };
  }

  let candidates: Candidate[];
  try {
    const extraction = await anthropic().messages.create({
      model: ANALYSIS_MODEL,
      max_tokens: 8000,
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: CANDIDATE_SCHEMA },
      },
      messages: [
        {
          role: "user",
          content: `Extract every competitor named below into structured form. Do not add any that are not mentioned.\n\n${prose}`,
        },
      ],
    });

    const text = textFromMessage(extraction);
    if (!text.ok) return { ok: false, error: text.error };
    candidates = (JSON.parse(text.text) as { candidates: Candidate[] }).candidates ?? [];
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return { ok: false, error: `Could not read the search result: ${detail}` };
  }

  const fresh = candidates.filter((candidate) => {
    const domain = candidate.domain.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
    return domain && !excluded.has(domain);
  });

  if (!fresh.length) {
    return { ok: true, suggestions: [], rejected: [] };
  }

  // Verify in parallel. Each is a handful of requests to someone else's site, so
  // the reader's own timeouts bound this rather than an outer deadline.
  const verified = await Promise.all(
    fresh.map(async (candidate) => ({
      candidate,
      read: await readStore(candidate.domain),
    })),
  );

  const rejected: { domain: string; reason: string }[] = [];
  const rows = [];

  for (const { candidate, read } of verified) {
    if (!isMonitorable(read) || !read) {
      rejected.push({
        domain: candidate.domain,
        reason: read?.note ?? "Could not be reached.",
      });
      continue;
    }

    rows.push({
      domain: read.domain,
      name: read.name ?? candidate.name,
      url: read.url,
      platform: read.platform,
      verified: true,
      evidence: {
        platform: read.platform,
        product_count: read.productCount ?? undefined,
        price_min: read.priceMin ?? undefined,
        price_max: read.priceMax ?? undefined,
        currency: read.currency ?? undefined,
        overlapping_categories: read.categories.slice(0, 5),
      },
      rationale: candidate.rationale,
      status: "suggested" as const,
    });
  }

  if (!rows.length) {
    return { ok: true, suggestions: [], rejected };
  }

  const { data: saved, error } = await supabase
    .from("competitor_suggestions")
    .upsert(rows, { onConflict: "domain" })
    .select();

  if (error) return { ok: false, error: error.message };

  return { ok: true, suggestions: (saved ?? []) as CompetitorSuggestion[], rejected };
}

/** Turn a suggestion into a monitored competitor, reusing the normal add path. */
export async function acceptSuggestion(
  id: string,
): Promise<{ ok: boolean; error?: string; warning?: string }> {
  await requireUser();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("competitor_suggestions")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "That suggestion no longer exists." };

  const suggestion = data as CompetitorSuggestion;

  // Reuse addCompetitor rather than inserting directly: it seeds all seven
  // signal configs and pushes the schedule to n8n. A competitor created any
  // other way is a row that never gets scraped.
  const form = new FormData();
  form.set("name", suggestion.name);
  form.set("url", suggestion.url);

  const result = await addCompetitor({ ok: false, error: null, warning: null }, form);

  if (!result.ok) return { ok: false, error: result.error ?? "Could not add that competitor." };

  await supabase.from("competitor_suggestions").update({ status: "accepted" }).eq("id", id);

  revalidatePath("/competitors");
  return { ok: true, warning: result.warning ?? undefined };
}

/** Dismiss. The row stays so the same site is never proposed again. */
export async function dismissSuggestion(id: string): Promise<{ ok: boolean; error?: string }> {
  await requireUser();

  const supabase = await createClient();
  const { error } = await supabase
    .from("competitor_suggestions")
    .update({ status: "dismissed" })
    .eq("id", id);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
