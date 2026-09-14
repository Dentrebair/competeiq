import { formatPrice } from "@/lib/format";
import type { Alert } from "@/lib/types/database";

/**
 * A short headline for an alert.
 *
 * WF-02 writes `summary` as two full sentences and there is no separate title
 * field, so every surface has been rendering a paragraph where a headline
 * belongs — a timeline of four-line previews, and a detail pane with a
 * three-line `<h2>`. That is the single cause of the density across the console.
 *
 * Rather than wait on a workflow change, compose the headline from columns that
 * already exist. For a price or promo move the interesting facts are the
 * magnitude and the product, and both are stored — so "28% off Varsity Brews
 * Tee" is derivable, exact, and eight words shorter than the sentence it
 * replaces.
 *
 * Nothing here invents. Where the parts are missing it falls back to the first
 * sentence of the summary, which is the best available short form, and the full
 * summary is still shown as the body everywhere the headline appears.
 */

/** First sentence, or a clean truncation. Never a mid-word cut. */
function firstSentence(text: string, max = 72): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "Change detected";

  const stop = flat.search(/[.!?](\s|$)/);
  const sentence = stop > 0 ? flat.slice(0, stop) : flat;
  if (sentence.length <= max) return sentence;

  const cut = sentence.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

export function alertTitle(alert: Alert): string {
  const magnitude =
    typeof alert.delta_pct === "number" && Number.isFinite(alert.delta_pct)
      ? Math.abs(alert.delta_pct)
      : null;
  const product = alert.product_title?.trim() || null;

  if (magnitude !== null && product) {
    // A promotion is framed as a discount, a price change as a cut or rise —
    // "28% off" and "28% price cut" describe different commercial moves and the
    // operator reads them differently.
    if (alert.signal_type === "promo_discount") {
      return `${magnitude.toFixed(0)}% off ${product}`;
    }
    if (alert.signal_type === "sku_price_change") {
      const direction = (alert.delta_pct ?? 0) < 0 ? "price cut" : "price rise";
      return `${magnitude.toFixed(0)}% ${direction} on ${product}`;
    }
  }

  // No "New:" prefix here, and that is not a style choice.
  //
  // For a catalogue change WF-02's Diff Catalog node does not put a product name
  // in `product_title` — it puts a summary of the diff:
  //
  //   product_title: added.length + ' products added, ' + removed.length + ' removed'
  //
  // So the value is already a headline ("3 products added, 1 removed") and
  // prefixing it produced "New: 3 products added, 1 removed". Verified against
  // wf-02-signal-processor.json rather than assumed from the column name.
  if (product && alert.signal_type === "catalog_change") {
    return product;
  }

  return firstSentence(alert.summary);
}

/**
 * The one-line "what actually moved", for a row that has no room for prose.
 *
 * Returns null rather than a placeholder when there are no figures — an empty
 * arrow reads as "it went to nothing", which for a price is a claim we cannot
 * make.
 */
export function alertMovement(alert: Alert): string | null {
  const before = formatPrice(alert.previous_price, alert.currency);
  const after = formatPrice(alert.current_price, alert.currency);
  return before && after ? `${before} → ${after}` : null;
}

/**
 * Why this severity, in three or four words.
 *
 * A bare "LOW" tells the operator the rating without the reason, and they have
 * no way to judge whether they agree. Severity is computed in WF-02 purely from
 * the size of the move, so the size *is* the explanation — and it is in the row
 * already.
 *
 * Only stated where it is genuinely derivable. For a catalogue change the band
 * comes from a removed-product count the app never receives, so inventing a
 * qualifier there would be exactly the false precision this codebase keeps
 * arguing against.
 */
export function severityReason(alert: Alert): string | null {
  if (!alert.ai_available) return null;

  const magnitude =
    typeof alert.delta_pct === "number" && Number.isFinite(alert.delta_pct)
      ? Math.abs(alert.delta_pct)
      : null;

  if (magnitude === null) return null;
  if (alert.signal_type === "promo_discount") return `${magnitude.toFixed(0)}% discount`;
  if (alert.signal_type === "sku_price_change") return `${magnitude.toFixed(0)}% move`;
  return null;
}
