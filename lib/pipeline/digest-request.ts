/**
 * Building the digest's user message — ported from WF-03's "Build Digest
 * Request" Code node (docs/n8n-claude-calls.md § 2). Pure function, no I/O,
 * so it can be unit tested without a database or Claude.
 */

export interface DigestAlertInput {
  id: number;
  competitor_name: string;
  signal_type: string;
  severity: string;
  summary: string;
  impact: string | null;
  recommended_action: string | null;
  created_at: string;
}

export interface BrandProfileInput {
  url?: string | null;
  name?: string | null;
  categories?: string[] | null;
  price_min?: number | string | null;
  price_max?: number | string | null;
  currency?: string | null;
  positioning?: string | null;
  priorities?: string | null;
  catalogue_source?: string | null;
}

/**
 * Same block WF-02 and WF-03 both built — kept in the user message, never the
 * cached system prompt, because it changes whenever the operator edits their
 * profile.
 *
 * Gated on `brand` existing at all, not on `brand.url` specifically — in
 * WF-03's era those were equivalent (a profile always had a url), but a
 * business with no website (catalogue_source 'described') has a real profile
 * worth including with `url` null.
 */
function brandBlock(brand: BrandProfileInput | null): string {
  if (!brand) return "";
  const identity = brand.name ?? brand.url;
  return [
    "<brand_profile>",
    identity ? `Brand: ${identity}` : null,
    brand.categories?.length ? `Sells: ${brand.categories.join(", ")}` : null,
    brand.price_min != null ? `Price range: ${brand.currency ?? ""} ${brand.price_min}–${brand.price_max}` : null,
    brand.positioning ? `Positioning (inferred): ${brand.positioning}` : null,
    brand.priorities ? `Their stated priorities: ${brand.priorities}` : null,
    brand.catalogue_source === "inferred"
      ? "NOTE: catalogue figures were INFERRED from their website, not read from a feed."
      : brand.catalogue_source === "described"
        ? "NOTE: this business has no website — the profile is based entirely on the operator's own description, not read from anything."
        : null,
    "</brand_profile>",
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildDigestUserContent(params: {
  alerts: DigestAlertInput[];
  competitorNames: string[];
  brand: BrandProfileInput | null;
  periodStart: Date;
  periodEnd: Date;
}): string {
  const { alerts, competitorNames, brand, periodStart, periodEnd } = params;

  return [
    brandBlock(brand),
    `Window: ${periodStart.toISOString()} to ${periodEnd.toISOString()}`,
    `Alert count: ${alerts.length}`,
    `Competitors monitored: ${competitorNames.join(", ")}`,
    "",
    "Alerts:",
    JSON.stringify(
      alerts.map((a) => ({
        // String, matching WF-03's schema for related_alert_ids/evidence_alert_ids
        // (citations in prose-adjacent JSON) — not the digests.alert_ids column.
        id: String(a.id),
        competitor: a.competitor_name,
        signal_type: a.signal_type,
        severity: a.severity,
        summary: a.summary,
        // Undefined (dropped by JSON.stringify), not null: an alert written
        // before WF-02 gained impact is absence of data, not absence of impact.
        impact: a.impact ?? undefined,
        recommended_action: a.recommended_action,
        detected_at: a.created_at,
      })),
      null,
      2,
    ),
  ].join("\n");
}
