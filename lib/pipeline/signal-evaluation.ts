import { INTERPRETATION_SYSTEM_PROMPT } from "./interpretation-prompt";

/**
 * Signal Evaluation: turning one Collection Run into Alerts and a new Baseline.
 *
 * A faithful port of the WF-02 Code nodes that decided output: Build Context,
 * Diff Price, Diff Catalog, Diff Promo, Build Claude Prompt, Parse Claude,
 * Claude Error Handler, Normalize Alert and Build Price Rows. The parity test
 * (test/pipeline/signal-evaluation.parity.test.ts) runs WF-02's own exported
 * code beside this file on the same inputs and requires identical output
 * (ADR-0004).
 *
 * Faithful includes WF-02's quirks, each marked "WF-02 quirk" below. Change one
 * only by changing the parity test on purpose, never as a side effect.
 *
 * Pure functions with no I/O, so the worker and the tests share one copy.
 */

export const INTERPRETATION_MODEL = "claude-haiku-4-5";
export const INTERPRETATION_MAX_TOKENS = 700;

/** A move smaller than this, in either direction, is not a price change. */
const PRICE_THRESHOLD_PCT = 5;
/** 10% off caught routine retail noise. 25% off is a deliberate commercial move. */
const MIN_DISCOUNT_PCT = 25;
/** Per signal, biggest first, so a whole-catalogue repricing cannot flood the feed. */
const MAX_ALERTS_PER_SIGNAL = 10;

/** The fields of a trovevault/shopify-products-scraper dataset item read here. */
export interface ApifyProduct {
  url?: string | null;
  title?: string | null;
  /** Major units: 30 means $30.00. Never divide by 100. */
  priceMin?: unknown;
  compareAtPrice?: unknown;
  currency?: string | null;
}

/** A `competitor_products` row as read back. PostgREST can return numerics as strings. */
export interface BaselineEntry {
  product_handle: string | null;
  last_price: number | string | null;
}

export interface CompetitorRef {
  id: string;
  name: string;
}

export type EvaluatedSignal = "sku_price_change" | "catalog_change" | "promo_discount";
export type Severity = "high" | "medium" | "low";

export interface DetectedChange {
  signal_type: EvaluatedSignal;
  product_title: string | null;
  product_handle: string | null;
  product_url: string | null;
  currency: string | null;
  previous_price: number | null;
  current_price: number | null;
  delta_pct: number | null;
  competitor_name: string;
  competitor_id: string;
  /** Catalog changes only. */
  added_count?: number;
  removed_count?: number;
  added_titles?: string;
}

/** The words Claude writes. Signal type and severity are never taken from it (ADR-0006). */
export interface Interpretation {
  summary: string;
  impact: string | null;
  recommended_action: string;
}

/** The columns of `alerts` that Signal Evaluation decides. */
export interface AlertRow {
  competitor_id: string | null;
  competitor_name: string;
  signal_type: string;
  severity: Severity;
  summary: string;
  impact: string | null;
  recommended_action: string;
  product_title: string | null;
  product_handle: string | null;
  product_url: string | null;
  currency: string | null;
  previous_price: number | null;
  current_price: number | null;
  delta_pct: number | null;
  ai_available: boolean;
  dedupe_key: string;
}

/** A `competitor_products` row to upsert. */
export interface BaselineRow {
  competitor_id: string;
  product_handle: string;
  product_title: string | null;
  product_url: string | null;
  currency: string | null;
  last_price: number | null;
  last_seen_at: string;
}

const isNumber = (value: unknown): value is number => typeof value === "number";

/** The actor returns no handle, so the slug is taken from the product URL. */
export function productHandle(product: ApifyProduct): string | null {
  return product.url
    ? (product.url.split("/products/").pop() ?? "").split("?")[0].replace(/\/$/, "")
    : null;
}

/**
 * Every change in one Collection Run, in WF-02's order: price, catalog, promo.
 *
 * An empty Baseline means this is the competitor's first run. Price and catalog
 * then report nothing, because every product would look new. Promo needs no
 * history and fires anyway.
 */
export function evaluateSignals(
  products: ApifyProduct[],
  baseline: BaselineEntry[],
  competitor: CompetitorRef,
): DetectedChange[] {
  const known = baseline.filter(
    (row): row is BaselineEntry & { product_handle: string } => Boolean(row && row.product_handle),
  );
  const firstRun = known.length === 0;

  return [
    ...diffPrice(products, known, competitor, firstRun),
    ...diffCatalog(products, known, competitor, firstRun),
    ...diffPromo(products, competitor),
  ];
}

function diffPrice(
  products: ApifyProduct[],
  known: Array<BaselineEntry & { product_handle: string }>,
  competitor: CompetitorRef,
  firstRun: boolean,
): DetectedChange[] {
  if (firstRun) return [];

  const previous = new Map<string, number | null>();
  for (const row of known) {
    previous.set(
      row.product_handle,
      row.last_price === null || row.last_price === undefined ? null : Number(row.last_price),
    );
  }

  const changes: DetectedChange[] = [];
  for (const product of products) {
    const handle = productHandle(product);
    if (!handle) continue;

    const currentPrice = isNumber(product.priceMin) ? product.priceMin : null;
    if (currentPrice === null) continue;

    const previousPrice = previous.get(handle);
    if (previousPrice === null || previousPrice === undefined) continue;

    // WF-02 quirk: a stored price of 0 gives an Infinity delta, which passes
    // the threshold and cannot be inserted into a numeric column.
    const deltaPct = ((currentPrice - previousPrice) / previousPrice) * 100;
    if (Math.abs(deltaPct) < PRICE_THRESHOLD_PCT) continue;

    changes.push({
      signal_type: "sku_price_change",
      product_title: product.title || handle,
      product_handle: handle,
      product_url: product.url || null,
      currency: product.currency || null,
      previous_price: previousPrice,
      current_price: currentPrice,
      delta_pct: Math.round(deltaPct * 10) / 10,
      competitor_name: competitor.name,
      competitor_id: competitor.id,
    });
  }

  changes.sort((a, b) => Math.abs(b.delta_pct ?? 0) - Math.abs(a.delta_pct ?? 0));
  return changes.slice(0, MAX_ALERTS_PER_SIGNAL);
}

function diffCatalog(
  products: ApifyProduct[],
  known: Array<BaselineEntry & { product_handle: string }>,
  competitor: CompetitorRef,
  firstRun: boolean,
): DetectedChange[] {
  const previousHandles = new Set(known.map((row) => row.product_handle));
  const currentHandles = new Set(products.map((product) => productHandle(product)).filter(Boolean));

  // WF-02 quirk: counted per dataset item, so a product listed twice in one
  // dataset is "added" twice.
  const added = products.filter((product) => {
    const handle = productHandle(product);
    return handle && !previousHandles.has(handle);
  });
  const removed = [...previousHandles].filter((handle) => !currentHandles.has(handle));

  if (firstRun || (added.length === 0 && removed.length === 0)) return [];

  return [
    {
      signal_type: "catalog_change",
      product_title: `${added.length} products added, ${removed.length} removed`,
      product_handle: null,
      product_url: null,
      currency: null,
      added_count: added.length,
      removed_count: removed.length,
      added_titles: added
        .slice(0, 5)
        .map((product) => product.title)
        .join(", "),
      previous_price: null,
      current_price: null,
      delta_pct: null,
      competitor_name: competitor.name,
      competitor_id: competitor.id,
    },
  ];
}

function diffPromo(products: ApifyProduct[], competitor: CompetitorRef): DetectedChange[] {
  const promos = products.flatMap((product) => {
    const compareAt = isNumber(product.compareAtPrice) ? product.compareAtPrice : 0;
    const price = isNumber(product.priceMin) ? product.priceMin : 0;
    if (!(compareAt > 0 && price > 0 && compareAt > price)) return [];
    const discountPct = ((compareAt - price) / compareAt) * 100;
    return discountPct < MIN_DISCOUNT_PCT ? [] : [{ product, compareAt, price, discountPct }];
  });

  // Deepest first, so the cap keeps the discounts that matter.
  promos.sort((a, b) => b.discountPct - a.discountPct);

  return promos.slice(0, MAX_ALERTS_PER_SIGNAL).map(({ product, compareAt, price, discountPct }) => ({
    signal_type: "promo_discount" as const,
    product_title: product.title ?? null,
    product_handle: productHandle(product),
    product_url: product.url || null,
    currency: product.currency || null,
    previous_price: compareAt,
    current_price: price,
    delta_pct: -Math.round(discountPct),
    competitor_name: competitor.name,
    competitor_id: competitor.id,
  }));
}

/** The Messages API request body for one change. */
export function interpretationRequest(change: DetectedChange) {
  const detail = {
    sku_price_change: `Product "${change.product_title}" price changed ${change.delta_pct}% from ${change.previous_price} to ${change.current_price}`,
    catalog_change: `${change.added_count} products added and ${change.removed_count} products removed. New items include: ${change.added_titles || "unknown"}`,
    promo_discount: `"${change.product_title}" is now ${Math.abs(change.delta_pct ?? 0)}% off. Was ${change.previous_price}, now ${change.current_price}`,
  }[change.signal_type];

  return {
    model: INTERPRETATION_MODEL,
    max_tokens: INTERPRETATION_MAX_TOKENS,
    system: INTERPRETATION_SYSTEM_PROMPT,
    messages: [
      {
        role: "user" as const,
        content: `Competitor: ${change.competitor_name}\nSignal: ${change.signal_type}\nDetail: ${detail}`,
      },
    ],
  };
}

/**
 * Claude's reply text, read as leniently as WF-02 read it.
 *
 * Haiku often wraps its JSON in a ```json fence or a sentence despite being told
 * not to, so unwrap before parsing. An unparseable reply still yields an Alert
 * whose summary is the raw text: the change itself is real either way.
 */
export function parseInterpretation(raw: string): Interpretation {
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(extractJson(raw));
    // WF-02 threw here on a bare `null` and failed the whole run. Defaults are
    // the only deliberate deviation, since there is no run-level retry to lean on.
    if (value && typeof value === "object") parsed = value as Record<string, unknown>;
  } catch {
    // Fall through to the defaults.
  }

  return {
    summary: text(parsed.summary) || raw || "Signal detected.",
    impact: text(parsed.impact) || null,
    recommended_action: text(parsed.recommended_action) || "Review this change manually.",
  };
}

function extractJson(reply: string): string {
  let body = String(reply || "").trim();
  const fenced = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced) body = fenced[1].trim();
  if (body.startsWith("{")) return body;
  const block = body.match(/\{[\s\S]*\}/);
  return block ? block[0] : body;
}

const text = (value: unknown): string =>
  typeof value === "string" ? value : value ? String(value) : "";

/**
 * Severity from the size of the move, never from Claude (ADR-0006).
 *
 * Bands differ per signal: Diff Promo already floors at 25% off, so 25% off is
 * the floor of interest, whereas a 25% price move is extreme.
 */
export function severityFor(
  change: Pick<DetectedChange, "signal_type" | "delta_pct" | "removed_count">,
): Severity {
  const size = Math.abs(Number(change.delta_pct));
  switch (change.signal_type) {
    case "sku_price_change":
      if (!Number.isFinite(size)) return "low";
      return size >= 15 ? "high" : size >= 5 ? "medium" : "low";
    case "promo_discount":
      if (!Number.isFinite(size)) return "low";
      return size >= 50 ? "high" : size >= 35 ? "medium" : "low";
    case "catalog_change":
      return Number(change.removed_count) > 0 ? "medium" : "low";
    default:
      return "low";
  }
}

/**
 * `{apify_run_id}:{signal_type}:{product_handle}`, or without the handle when
 * there is none. Apify can deliver a completion more than once, and this key is
 * what makes the second insert a no-op.
 */
export function dedupeKey(
  runId: string,
  change: Pick<DetectedChange, "signal_type" | "product_handle">,
): string {
  return [runId || "unknown-run", change.signal_type || "unknown", change.product_handle || null]
    .filter(Boolean)
    .join(":");
}

const toNumber = (value: unknown): number | null =>
  value === undefined || value === "" || value === null ? null : Number(value);

/**
 * The Alert for one change. `interpretation` is null when Claude could not be
 * reached after retries: the Alert is still written, marked unavailable, and
 * the UI renders it as Unclassified.
 */
export function alertRow(
  change: DetectedChange,
  interpretation: Interpretation | null,
  runId: string,
): AlertRow {
  const reading = interpretation ?? {
    summary: `Signal detected on ${change.competitor_name}: ${change.signal_type}. AI processing was unavailable.`,
    impact: null,
    recommended_action: "Review the change manually.",
  };

  return {
    competitor_id: change.competitor_id || null,
    competitor_name: change.competitor_name || "unknown",
    signal_type: change.signal_type || "unknown",
    severity: severityFor(change),
    summary: reading.summary || "",
    impact: reading.impact || null,
    recommended_action: reading.recommended_action || "",
    product_title: change.product_title || null,
    product_handle: change.product_handle || null,
    product_url: change.product_url || null,
    currency: change.currency || null,
    previous_price: toNumber(change.previous_price),
    current_price: toNumber(change.current_price),
    delta_pct: toNumber(change.delta_pct),
    ai_available: interpretation !== null,
    dedupe_key: dedupeKey(runId, change),
  };
}

/**
 * The Baseline after this run: one row per product handle, first occurrence wins.
 *
 * WF-02 quirk: this upserts only what was scraped. A product that disappears is
 * never deleted from the Baseline, so Diff Catalog reports it as removed again
 * on every later run.
 */
export function baselineRows(products: ApifyProduct[], competitorId: string, now: Date): BaselineRow[] {
  const seen = new Set<string>();
  const rows: BaselineRow[] = [];

  for (const product of products) {
    const handle = productHandle(product);
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    rows.push({
      competitor_id: competitorId,
      product_handle: handle,
      product_title: product.title || null,
      product_url: product.url || null,
      currency: product.currency || null,
      last_price: isNumber(product.priceMin) ? product.priceMin : null,
      last_seen_at: now.toISOString(),
    });
  }

  return rows;
}
