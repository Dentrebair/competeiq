import type { ApifyProduct, BaselineEntry } from "./signal-evaluation";
import { productHandle } from "./signal-evaluation";

/**
 * One row per product this run touched, so one bad run can be reversed without
 * touching later ones (`baseline_history`, supabase/07-pipeline-worker.sql).
 *
 * Not part of the WF-02 port — n8n never wrote this table — so it is a new pure
 * function rather than an addition to signal-evaluation.ts's parity surface.
 */
export interface BaselineHistoryRow {
  run_id: string;
  competitor_id: string;
  product_handle: string;
  was_new: boolean;
  previous_price: number | null;
  current_price: number | null;
}

const isNumber = (value: unknown): value is number => typeof value === "number";

/**
 * Every product this run upserted into the Baseline, first occurrence per
 * handle wins (matches baselineRows in signal-evaluation.ts).
 */
export function baselineHistoryRows(
  products: ApifyProduct[],
  previousBaseline: BaselineEntry[],
  competitorId: string,
  runId: string,
): BaselineHistoryRow[] {
  const previous = new Map<string, number | null>();
  for (const row of previousBaseline) {
    if (!row.product_handle) continue;
    previous.set(
      row.product_handle,
      row.last_price === null || row.last_price === undefined ? null : Number(row.last_price),
    );
  }

  const seen = new Set<string>();
  const rows: BaselineHistoryRow[] = [];

  for (const product of products) {
    const handle = productHandle(product);
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);

    const wasKnown = previous.has(handle);
    rows.push({
      run_id: runId,
      competitor_id: competitorId,
      product_handle: handle,
      was_new: !wasKnown,
      previous_price: wasKnown ? (previous.get(handle) ?? null) : null,
      current_price: isNumber(product.priceMin) ? product.priceMin : null,
    });
  }

  return rows;
}
