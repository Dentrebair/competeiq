/**
 * Read an ecommerce storefront's catalogue, by whichever route it will allow.
 *
 * Used twice: once on the operator's own store during onboarding, and again on
 * every competitor suggested to them — because "can we actually read this site"
 * is exactly what makes a suggestion worth showing.
 *
 * No `server-only` marker, deliberately, and for a different reason than
 * lib/signals.ts. This module holds no secrets — it fetches public web pages —
 * and leaving it importable outside Next means it can be exercised directly
 * under node, against real storefronts, which is the only way to know the field
 * mappings below are right. Its callers (app/actions/onboarding.ts) are
 * server-only, and a browser could not run this anyway: CORS blocks every
 * request it makes.
 *
 * ---------------------------------------------------------------------------
 * Three tiers, and the honesty rule that governs them
 *
 *   confirmed  — the platform served a machine-readable product feed.
 *   page_data  — no feed, so the sitemap plus the structured product markup
 *                storefronts publish for search engines, sampled.
 *   inferred   — neither worked. Nothing here can tell you about the catalogue;
 *                the caller falls back to reading the site with a model.
 *
 * The rule: a route that fails is NOT evidence about the store. Verified against
 * real sites while building this —
 *
 *   deathwishcoffee.com  /products.json -> 200 JSON, 152 products
 *   blackriflecoffee.com /products.json -> 403 text/html
 *   lavazza.co.uk        /products.json -> 301 to HTML
 *
 * The last two are Shopify-shaped requests being refused, not shops with no
 * products. Treating a 403 or an HTML body as "zero products" would write
 * `product_count: 0` into the brand profile and then reason from it forever.
 * Every reader below must clear four gates before it believes anything: HTTP
 * 200, a JSON content type, a body that parses, and the shape it expected.
 * ---------------------------------------------------------------------------
 */

export type CatalogueSource = "confirmed" | "page_data" | "inferred";

export interface StoreRead {
  /** The origin actually read, after normalising and following redirects. */
  url: string;
  domain: string;
  /** 'shopify' | 'woocommerce' | 'other' | 'unknown' */
  platform: string;
  /** null when no route yielded catalogue data at all. */
  source: CatalogueSource | null;
  name: string | null;
  /** Store's own blurb where the platform exposes one. Useful for positioning. */
  description: string | null;
  currency: string | null;
  /**
   * Exact count, or null.
   *
   * Only ever set at `confirmed`. A sitemap sample can tell you products exist;
   * it cannot count them, and extrapolating "3 of 10 sampled pages were products
   * × 669 URLs" into "≈200 products" is false precision that reads identically
   * to a real figure once it is sitting in a database column.
   */
  productCount: number | null;
  priceMin: number | null;
  priceMax: number | null;
  categories: string[];
  sampleTitles: string[];
  /**
   * Whether the site answered at all, as distinct from whether we could read its
   * catalogue.
   *
   * These are genuinely different situations and conflating them produces a
   * misleading message. blackriflecoffee.com answers every request with HTTP 403:
   * it is a real, well-known storefront that refuses automated clients. Telling
   * the operator to "check the address" for a site that plainly exists is wrong,
   * and rejecting it as a competitor suggestion on those grounds would be a false
   * negative — Apify drives a real browser and may well scrape it fine.
   */
  reachable: boolean;
  /** What happened, in one line. Shown to the operator and worth logging. */
  note: string;
}

/** Browser-ish. Plenty of storefronts refuse an obvious bot outright. */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = 12_000;
/** 250 is Shopify's per-page maximum; four pages covers 1,000 products. */
const MAX_FEED_PAGES = 4;
const SHOPIFY_PAGE_SIZE = 250;
/** Sitemap URLs to actually fetch. Each is a round trip to someone else's site. */
const PAGE_SAMPLE_SIZE = 12;

interface FetchResult {
  ok: boolean;
  status: number;
  contentType: string;
  body: string;
  finalUrl: string;
}

async function get(url: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
    });
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body,
      finalUrl: response.url || url,
    };
  } catch {
    // Timeout, DNS failure, TLS failure, connection refused. All mean "this
    // route did not answer", never "this store is empty".
    return { ok: false, status: 0, contentType: "", body: "", finalUrl: url };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse a response as JSON only if it is genuinely JSON.
 *
 * The content-type gate is what stops a 200-with-an-HTML-error-page — a shape
 * several CDNs return for a blocked request — from reaching JSON.parse and
 * throwing somewhere far less informative.
 */
function asJson(result: FetchResult): unknown | null {
  if (!result.ok) return null;
  if (!result.contentType.toLowerCase().includes("json")) return null;
  try {
    return JSON.parse(result.body);
  } catch {
    return null;
  }
}

/** Accepts "example.com", "https://example.com/collections/all", and the rest. */
export function normaliseStoreUrl(input: string): URL | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname.includes(".")) return null;
    // Origin only — a catalogue lives at the root, not under whatever page the
    // operator happened to copy out of their address bar.
    return new URL(url.origin);
  } catch {
    return null;
  }
}

function priceRange(values: number[]): { min: number | null; max: number | null } {
  const usable = values.filter((v) => Number.isFinite(v) && v > 0);
  if (!usable.length) return { min: null, max: null };
  return { min: Math.min(...usable), max: Math.max(...usable) };
}

function topCategories(values: string[], limit = 8): string[] {
  const counts = new Map<string, number>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value]) => value);
}

/* ==========================================================================
 * Tier 1a — Shopify
 *
 * Field mapping taken from a real response (deathwishcoffee.com), not from
 * memory. Two things that bite:
 *
 *   * `variants[].price` is a STRING ("8.00"), not a number.
 *   * products.json carries no currency at all. It comes from /meta.json, which
 *     also hands over the store's name and its own description — both worth more
 *     for positioning than anything a model would infer from the homepage.
 *
 * Paging: `?page=N` past the end returns `{"products": []}` rather than a 404,
 * so an empty page is the terminator.
 * ========================================================================== */

interface ShopifyVariant {
  price?: string | number;
  available?: boolean;
}
interface ShopifyProduct {
  title?: string;
  product_type?: string;
  tags?: string[];
  variants?: ShopifyVariant[];
}

async function readShopify(origin: string): Promise<Partial<StoreRead> | null> {
  const first = await get(`${origin}/products.json?limit=${SHOPIFY_PAGE_SIZE}`);
  const parsed = asJson(first);

  if (!parsed || typeof parsed !== "object") return null;
  const page = parsed as { products?: unknown };
  if (!Array.isArray(page.products)) return null;

  const products: ShopifyProduct[] = [...(page.products as ShopifyProduct[])];

  // An empty first page is ambiguous — a genuinely empty store, or a shop that
  // hides its feed. Either way there is nothing to build a profile from, so let
  // the next tier try rather than recording a zero.
  if (products.length === 0) return null;

  for (let pageNumber = 2; pageNumber <= MAX_FEED_PAGES; pageNumber++) {
    if (products.length < SHOPIFY_PAGE_SIZE * (pageNumber - 1)) break;
    const next = asJson(
      await get(`${origin}/products.json?limit=${SHOPIFY_PAGE_SIZE}&page=${pageNumber}`),
    ) as { products?: ShopifyProduct[] } | null;
    if (!next || !Array.isArray(next.products) || next.products.length === 0) break;
    products.push(...next.products);
  }

  const prices: number[] = [];
  const categories: string[] = [];
  const titles: string[] = [];

  for (const product of products) {
    if (product.title) titles.push(product.title);
    if (product.product_type) categories.push(product.product_type);
    if (Array.isArray(product.tags)) categories.push(...product.tags);
    for (const variant of product.variants ?? []) {
      // String prices. `Number("8.00")` is 8; `Number("")` is 0, which is why
      // the range filter drops non-positive values rather than trusting these.
      const value = typeof variant.price === "string" ? Number(variant.price) : variant.price;
      if (typeof value === "number") prices.push(value);
    }
  }

  const meta = asJson(await get(`${origin}/meta.json`)) as
    | { name?: string; currency?: string; description?: string }
    | null;

  const { min, max } = priceRange(prices);
  const hitCap = products.length >= SHOPIFY_PAGE_SIZE * MAX_FEED_PAGES;

  return {
    platform: "shopify",
    source: "confirmed",
    name: meta?.name ?? null,
    description: meta?.description ?? null,
    currency: meta?.currency ?? null,
    // Suppressed at the cap: past this point the number is a floor, not a count,
    // and a floor written into a column reads exactly like a total.
    productCount: hitCap ? null : products.length,
    priceMin: min,
    priceMax: max,
    categories: topCategories(categories),
    sampleTitles: titles.slice(0, 12),
    note: hitCap
      ? `Read ${products.length}+ products from the Shopify product feed (stopped at the page cap).`
      : `Read ${products.length} products from the Shopify product feed.`,
  };
}

/* ==========================================================================
 * Tier 1b — WooCommerce Store API
 *
 * The public read-only Store API, which needs no key — unlike the older
 * /wp-json/wc/v3 endpoints, which do.
 *
 * NOT verified against a live store, unlike the Shopify path above. The mapping
 * follows the documented shape: an array of products, each with `name`,
 * `prices: { price, currency_code, currency_minor_unit }`, and `categories[]`.
 * The four gates in asJson() plus the shape check mean a wrong guess here
 * degrades to the next tier rather than producing bad data — but treat the field
 * names as unconfirmed until this has met a real WooCommerce site.
 *
 * `prices.price` is a minor-unit STRING ("1299" = 12.99 at minor_unit 2). Do not
 * "fix" a price that looks 100× too large by dividing when it seems big — read
 * currency_minor_unit and divide by that, always.
 * ========================================================================== */

interface WooProduct {
  name?: string;
  prices?: { price?: string; currency_code?: string; currency_minor_unit?: number };
  categories?: { name?: string }[];
}

async function readWooCommerce(origin: string): Promise<Partial<StoreRead> | null> {
  const result = await get(`${origin}/wp-json/wc/store/v1/products?per_page=100`);
  const parsed = asJson(result);
  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  const products = parsed as WooProduct[];
  // Shape gate: an array of something else entirely (a WP error envelope, a
  // different plugin's endpoint) must not be read as a catalogue.
  if (!products.some((p) => typeof p?.name === "string")) return null;

  const prices: number[] = [];
  const categories: string[] = [];
  const titles: string[] = [];
  let currency: string | null = null;

  for (const product of products) {
    if (product.name) titles.push(product.name);
    for (const category of product.categories ?? []) {
      if (category?.name) categories.push(category.name);
    }
    const raw = product.prices?.price;
    const minorUnit = product.prices?.currency_minor_unit ?? 2;
    if (typeof raw === "string" && raw !== "") {
      const value = Number(raw) / 10 ** minorUnit;
      if (Number.isFinite(value)) prices.push(value);
    }
    currency ??= product.prices?.currency_code ?? null;
  }

  const { min, max } = priceRange(prices);

  return {
    platform: "woocommerce",
    source: "confirmed",
    currency,
    // Capped at one page of 100, so this is a floor rather than a count.
    productCount: products.length < 100 ? products.length : null,
    priceMin: min,
    priceMax: max,
    categories: topCategories(categories),
    sampleTitles: titles.slice(0, 12),
    note: `Read ${products.length} products from the WooCommerce Store API.`,
  };
}

/* ==========================================================================
 * Tier 2 — sitemap + structured product markup
 *
 * For everything that has no open feed. Storefronts publish schema.org Product
 * markup because Google's rich results need it, which makes it the one thing
 * that is present across platforms.
 *
 * Two things learned from lavazza.co.uk while building this, both of which the
 * obvious implementation gets wrong:
 *
 *   * Product URLs are NOT identifiable by path pattern. That site's sitemap is
 *     669 flat slugs — /en/beans-bundle sits beside /en/private-events with
 *     nothing to tell them apart. So: sample and check, never pattern-match.
 *
 *   * A Product block often carries NO PRICE. All three products found there had
 *     `offers.price` absent. So a price band is optional output here, and a store
 *     with no readable prices must report none rather than a range built from
 *     whatever stray numbers turned up.
 * ========================================================================== */

function extractLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
}

async function findSitemapUrls(origin: string): Promise<string[]> {
  // robots.txt first — it is where a site declares the real location, which is
  // often not /sitemap.xml.
  const robots = await get(`${origin}/robots.txt`);
  const declared = robots.ok
    ? [...robots.body.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1])
    : [];

  const roots = declared.length ? declared : [`${origin}/sitemap.xml`];
  const urls: string[] = [];

  for (const root of roots.slice(0, 3)) {
    const result = await get(root);
    if (!result.ok || !result.body.includes("<loc")) continue;

    const locs = extractLocs(result.body);

    // A sitemap index points at more sitemaps rather than at pages. Follow a
    // couple; following all of them on a large catalogue is dozens of requests.
    if (/<sitemapindex/i.test(result.body)) {
      for (const child of locs.slice(0, 3)) {
        const childResult = await get(child);
        if (childResult.ok) urls.push(...extractLocs(childResult.body));
      }
    } else {
      urls.push(...locs);
    }

    if (urls.length) break;
  }

  return urls;
}

interface LdProduct {
  name?: string;
  category?: string | string[];
  offers?: unknown;
}

/** Flatten every JSON-LD shape sites actually use: object, array, and @graph. */
function ldNodes(html: string): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const blocks = html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );

  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block[1].trim());
    } catch {
      continue; // Malformed JSON-LD is common and never worth failing over.
    }
    const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== "object") continue;
      const record = node as Record<string, unknown>;
      if (Array.isArray(record["@graph"])) queue.push(...(record["@graph"] as unknown[]));
      nodes.push(record);
    }
  }
  return nodes;
}

function isProduct(node: Record<string, unknown>): boolean {
  const type = node["@type"];
  if (typeof type === "string") return type === "Product";
  if (Array.isArray(type)) return type.includes("Product");
  return false;
}

/** Price out of `offers`, which is an object, an array, or an AggregateOffer. */
function offerPrices(offers: unknown): { prices: number[]; currency: string | null } {
  const prices: number[] = [];
  let currency: string | null = null;

  const queue = Array.isArray(offers) ? [...offers] : [offers];
  for (const entry of queue) {
    if (!entry || typeof entry !== "object") continue;
    const offer = entry as Record<string, unknown>;
    currency ??= typeof offer.priceCurrency === "string" ? offer.priceCurrency : null;

    for (const key of ["price", "lowPrice", "highPrice"]) {
      const raw = offer[key];
      const value = typeof raw === "string" ? Number(raw) : raw;
      if (typeof value === "number" && Number.isFinite(value)) prices.push(value);
    }
  }
  return { prices, currency };
}

async function readPageData(origin: string): Promise<Partial<StoreRead> | null> {
  const urls = await findSitemapUrls(origin);
  if (!urls.length) return null;

  // Evenly spaced rather than the first N — the head of a sitemap is usually
  // homepage, about, contact, and other things that are not products.
  const step = Math.max(1, Math.floor(urls.length / PAGE_SAMPLE_SIZE));
  const sample: string[] = [];
  for (let i = 0; i < urls.length && sample.length < PAGE_SAMPLE_SIZE; i += step) {
    sample.push(urls[i]);
  }

  const pages = await Promise.all(sample.map((url) => get(url)));

  const prices: number[] = [];
  const categories: string[] = [];
  const titles: string[] = [];
  let currency: string | null = null;
  let productPages = 0;

  for (const page of pages) {
    if (!page.ok || !page.body) continue;
    for (const node of ldNodes(page.body)) {
      if (!isProduct(node)) continue;
      productPages++;
      const product = node as LdProduct;
      if (typeof product.name === "string") titles.push(product.name);
      if (typeof product.category === "string") categories.push(product.category);
      else if (Array.isArray(product.category)) categories.push(...product.category);

      const found = offerPrices(product.offers);
      prices.push(...found.prices);
      currency ??= found.currency;
    }
  }

  if (productPages === 0) return null;

  const { min, max } = priceRange(prices);

  return {
    platform: "other",
    source: "page_data",
    currency,
    // Never a count at this tier. See the field's documentation.
    productCount: null,
    priceMin: min,
    priceMax: max,
    categories: topCategories(categories),
    sampleTitles: titles.slice(0, 12),
    note:
      `Found ${productPages} product page(s) in a sample of ${sample.length} from the sitemap` +
      (min === null
        ? ". No prices were published in the page markup, so there is no price range."
        : "."),
  };
}

/* ========================================================================== */

/**
 * Read a storefront. Never throws — every failure is a tier, not an exception.
 *
 * A caller that gets `source: null` should fall back to reading the site with a
 * model and record the result as `inferred`, so the uncertainty travels with the
 * data instead of being forgotten one screen later.
 */
export async function readStore(input: string): Promise<StoreRead | null> {
  const origin = normaliseStoreUrl(input);
  if (!origin) return null;

  const base: StoreRead = {
    url: origin.origin,
    domain: origin.hostname.replace(/^www\./, ""),
    platform: "unknown",
    source: null,
    name: null,
    description: null,
    currency: null,
    productCount: null,
    priceMin: null,
    priceMax: null,
    categories: [],
    sampleTitles: [],
    reachable: false,
    note: "",
  };

  // Cheapest and most reliable first; each tier only runs because the one above
  // declined to answer.
  const shopify = await readShopify(origin.origin);
  if (shopify) return { ...base, ...shopify, reachable: true };

  const woo = await readWooCommerce(origin.origin);
  if (woo) return { ...base, ...woo, reachable: true };

  const pageData = await readPageData(origin.origin);
  if (pageData) return { ...base, ...pageData, reachable: true };

  // Three outcomes, and the difference matters to whoever reads the message.
  const homepage = await get(origin.origin);

  if (homepage.ok) {
    return {
      ...base,
      reachable: true,
      note: "The site is reachable but publishes no readable catalogue. Details will have to be inferred from its pages.",
    };
  }

  // Answered, but refused us. Verified against blackriflecoffee.com, which
  // returns 403 to anything that is not a real browser.
  if (homepage.status > 0) {
    return {
      ...base,
      reachable: true,
      note: `${origin.hostname} is online but blocks automated reads (HTTP ${homepage.status}), so its catalogue could not be checked from here.`,
    };
  }

  // No answer at all: DNS, TLS, or connection failure. This is the only one of
  // the three where "check the address" is useful advice.
  return {
    ...base,
    note: `Could not reach ${origin.hostname} at all — no response. Check the address.`,
  };
}

/**
 * The visible text of a page, for the cases where nothing machine-readable
 * exists.
 *
 * This is what makes the `inferred` tier work without a web-search tool: fetch
 * the homepage, strip it to prose, and let the model read that. Deterministic,
 * one request, and it keeps the enrichment call free of tools — which matters,
 * because a tool-using call cannot also be constrained to a JSON schema without
 * complications this does not need.
 *
 * Returns null when the page cannot be fetched at all. An empty string would be
 * indistinguishable from a page that genuinely says nothing.
 */
export async function fetchPageText(url: string, maxChars = 12_000): Promise<string | null> {
  const result = await get(url);
  if (!result.ok || !result.body) return null;

  const text = result.body
    // Script and style bodies are not prose and swamp everything that is.
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();

  return text ? text.slice(0, maxChars) : null;
}

/**
 * Whether a read is solid enough to justify offering the site as a competitor.
 *
 * Requires actual catalogue data, not merely a reachable domain — the evidence
 * line under a suggestion ("Shopify · 142 products · $12–$38") is what makes it
 * possible to reject a bad suggestion in a second, and there is nothing to show
 * without this.
 *
 * A site that is `reachable` but not monitorable is not a dead end: the operator
 * can still add it by hand, and the note explains why it could not be confirmed.
 */
export function isMonitorable(read: StoreRead | null): boolean {
  return Boolean(read && read.source !== null);
}
