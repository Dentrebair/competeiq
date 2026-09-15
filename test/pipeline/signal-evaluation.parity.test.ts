import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  alertRow,
  baselineRows,
  evaluateSignals,
  interpretationRequest,
  parseInterpretation,
  productHandle,
  severityFor,
  type ApifyProduct,
  type BaselineEntry,
} from "@/lib/pipeline/signal-evaluation";

import { runWf02Reference } from "../reference/wf02-reference";

/**
 * Parity: the port must produce exactly what WF-02's own code produces.
 *
 * Products are a real Death Wish Coffee dataset (Apify run 7K7t0Nh2X0lqm7i9D,
 * 2026-08-23). Each scenario varies only the Baseline, or a copy of the dataset,
 * to drive one branch of the diff. Each also asserts the branch actually fired,
 * so a scenario can never pass by producing nothing on both sides.
 */

type Product = ApifyProduct & { url: string; title: string; priceMin: number };

const PRODUCTS = JSON.parse(
  readFileSync(new URL("../fixtures/apify/deathwish-2026-08-23.json", import.meta.url), "utf8"),
) as Product[];

const COMPETITOR = {
  id: "9d6c4723-e9d9-4e1b-98e7-f313237f25be",
  name: "Death Wish Coffee",
  domain: "deathwishcoffee.com",
};
const RUN_ID = "7K7t0Nh2X0lqm7i9D";
const DATASET_ID = "ofSwJinQWclbR8c4K";
const NOW = new Date("2026-09-14T08:00:00.000Z");

const REPLIES = [
  '{"severity":"high","summary":"Clean reply. Second sentence.","impact":"Lands on your core range. It pressures entry price points.","recommended_action":"Reprice the 10oz ground SKU today."}',
  '```json\n{"severity":"low","summary":"Fenced reply. Second sentence.","impact":"Fenced impact.","recommended_action":"Fenced action."}\n```',
  'Here is my reading:\n{"summary":"Wrapped in prose. Second sentence.","impact":"Wrapped impact.","recommended_action":"Wrapped action."}\nHope this helps.',
  "Not JSON at all.",
  '{"summary":"Only a summary came back."}',
  "",
];
const replyCycle = (index: number) => REPLIES[index % REPLIES.length];
const allFail = () => null;

const exactBaseline = (products: Product[] = PRODUCTS): BaselineEntry[] =>
  products.map((product) => ({ product_handle: productHandle(product), last_price: product.priceMin }));

const priced = PRODUCTS.filter((product) => product.priceMin > 0);
const handleOf = (product: Product) => productHandle(product) as string;

function withPrices(overrides: Map<string, number | string | null>): BaselineEntry[] {
  return exactBaseline().map((row) =>
    overrides.has(row.product_handle as string)
      ? { ...row, last_price: overrides.get(row.product_handle as string) ?? null }
      : row,
  );
}

interface Scenario {
  name: string;
  products: Product[];
  baseline: BaselineEntry[];
  reply: (index: number) => string | null;
  fired: (changes: ReturnType<typeof evaluateSignals>) => void;
}

const SCENARIOS: Scenario[] = [
  {
    name: "first run: Baseline captured, only promos reported",
    products: PRODUCTS,
    baseline: [],
    reply: replyCycle,
    fired: (changes) => {
      expect(changes).toHaveLength(10);
      expect(new Set(changes.map((change) => change.signal_type))).toEqual(new Set(["promo_discount"]));
    },
  },
  {
    name: "price moves around the thresholds",
    products: PRODUCTS,
    baseline: withPrices(
      new Map<string, number | string | null>([
        [handleOf(priced[0]), priced[0].priceMin * 1.25], // -20%: high
        [handleOf(priced[1]), priced[1].priceMin / 1.2], // +20%: high
        [handleOf(priced[2]), priced[2].priceMin / 1.1], // +10%: medium
        [handleOf(priced[3]), priced[3].priceMin * 1.049], // under 5%: ignored
        [handleOf(priced[4]), String(priced[4].priceMin * 1.3)], // PostgREST string numeric
        [handleOf(priced[5]), null], // no stored price: ignored
        [handleOf(priced[6]), priced[6].priceMin / 1.05], // the 5% boundary
      ]),
    ),
    reply: replyCycle,
    fired: (changes) => {
      const prices = changes.filter((change) => change.signal_type === "sku_price_change");
      expect(prices.length).toBeGreaterThanOrEqual(4);
      expect(prices.map((change) => change.product_handle)).not.toContain(handleOf(priced[3]));
    },
  },
  {
    name: "more price moves than the cap: biggest ten kept",
    products: PRODUCTS,
    baseline: withPrices(
      new Map(priced.slice(0, 14).map((product, index) => [handleOf(product), product.priceMin * (1 + (index + 2) * 0.03)])),
    ),
    reply: replyCycle,
    fired: (changes) => {
      expect(changes.filter((change) => change.signal_type === "sku_price_change")).toHaveLength(10);
    },
  },
  {
    name: "products added and removed, with a duplicate listing",
    products: [...PRODUCTS, { ...PRODUCTS[0], url: `${PRODUCTS[0].url}?variant=123` }],
    baseline: [
      ...exactBaseline().slice(3),
      { product_handle: "discontinued-blend", last_price: 19.99 },
      { product_handle: "retired-mug", last_price: null },
    ],
    reply: replyCycle,
    fired: (changes) => {
      const catalog = changes.find((change) => change.signal_type === "catalog_change");
      expect(catalog).toMatchObject({ added_count: 4, removed_count: 2 });
    },
  },
  {
    // More than five added, so the five-title limit in the Claude detail is exercised.
    name: "products added only",
    products: PRODUCTS,
    baseline: exactBaseline().slice(7),
    reply: replyCycle,
    fired: (changes) => {
      expect(changes.find((change) => change.signal_type === "catalog_change")).toMatchObject({
        added_count: 7,
        removed_count: 0,
      });
    },
  },
  {
    // Fewer promos than the cap, so the floor itself decides what is reported.
    name: "promo floor and bands",
    products: PRODUCTS.map((product, index) => {
      const promo = [
        { priceMin: 15, compareAtPrice: 20 }, // exactly 25% off: reported, low
        { priceMin: 15.1, compareAtPrice: 20 }, // 24.5% off: below the floor
        { priceMin: 13, compareAtPrice: 20 }, // 35% off: medium
        { priceMin: 10, compareAtPrice: 20 }, // 50% off: high
      ][index];
      return promo ? { ...product, ...promo } : { ...product, compareAtPrice: null };
    }),
    baseline: [],
    reply: replyCycle,
    fired: (changes) => {
      expect(changes.map((change) => change.delta_pct)).toEqual([-50, -35, -25]);
    },
  },
  {
    name: "no change at all",
    products: PRODUCTS.map((product) => ({ ...product, compareAtPrice: null })),
    baseline: exactBaseline(),
    reply: replyCycle,
    fired: (changes) => expect(changes).toEqual([]),
  },
  {
    name: "Claude unavailable for every change",
    products: PRODUCTS,
    baseline: withPrices(new Map([[handleOf(priced[0]), priced[0].priceMin * 1.25]])),
    reply: allFail,
    fired: (changes) => expect(changes.length).toBeGreaterThan(1),
  },
];

describe("Signal Evaluation matches WF-02", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(SCENARIOS)("$name", async (scenario) => {
    const reference = await runWf02Reference({
      products: scenario.products as unknown as Record<string, unknown>[],
      baseline: scenario.baseline as unknown as Record<string, unknown>[],
      competitor: COMPETITOR,
      runId: RUN_ID,
      datasetId: DATASET_ID,
      reply: scenario.reply,
    });

    const changes = evaluateSignals(scenario.products, scenario.baseline, COMPETITOR);
    scenario.fired(changes);

    expect(changes).toEqual(reference.changes);
    expect(changes.map(interpretationRequest)).toEqual(reference.prompts);
    expect(
      changes.map((change, index) => {
        const reply = scenario.reply(index);
        return alertRow(change, reply === null ? null : parseInterpretation(reply), RUN_ID);
      }),
    ).toEqual(reference.alerts);

    // last_in_stock has no WF-02 equivalent — added after the port, and not
    // part of the parity surface (see evaluateSignals's doc comment). Stripped
    // before the parity comparison, then checked directly against the
    // fixture's own available/fullyOutOfStock fields.
    const baseline = baselineRows(scenario.products, COMPETITOR.id, NOW);
    expect(
      baseline.map((row) => ({
        competitor_id: row.competitor_id,
        product_handle: row.product_handle,
        product_title: row.product_title,
        product_url: row.product_url,
        currency: row.currency,
        last_price: row.last_price,
        last_seen_at: row.last_seen_at,
      })),
    ).toEqual(reference.baselineRows);

    const expectedStock = new Map<string, boolean | null>();
    for (const product of scenario.products) {
      const handle = productHandle(product);
      if (!handle || expectedStock.has(handle)) continue;
      expectedStock.set(
        handle,
        typeof product.fullyOutOfStock === "boolean"
          ? !product.fullyOutOfStock
          : typeof product.available === "boolean"
            ? product.available
            : null,
      );
    }
    expect(baseline.map((row) => [row.product_handle, row.last_in_stock])).toEqual([
      ...expectedStock.entries(),
    ]);
  });
});

describe("severity bands", () => {
  it.each([
    ["sku_price_change", 4.9, "low"],
    ["sku_price_change", -5, "medium"],
    ["sku_price_change", 14.9, "medium"],
    ["sku_price_change", -15, "high"],
    ["promo_discount", -34, "low"],
    ["promo_discount", -35, "medium"],
    ["promo_discount", -49, "medium"],
    ["promo_discount", -50, "high"],
  ] as const)("%s at %d%% is %s", (signal_type, delta_pct, expected) => {
    expect(severityFor({ signal_type, delta_pct })).toBe(expected);
  });

  it("rates a catalog change medium only when products were removed", () => {
    expect(severityFor({ signal_type: "catalog_change", delta_pct: null, removed_count: 1 })).toBe("medium");
    expect(severityFor({ signal_type: "catalog_change", delta_pct: null, removed_count: 0 })).toBe("low");
  });
});
