import { isKnownSignalType, signalTypeLabel, type SignalType } from "@/lib/signals";
import { normalizeSeverity, type Severity } from "@/lib/types/database";
import type { ReactNode } from "react";

/**
 * The small vocabulary every screen shares.
 *
 * Kept in one file because the alternative is four definitions of "what a
 * critical looks like" drifting apart across Overview, Intelligence, Alerts and
 * Competitors — which is exactly how a severity scale stops meaning anything.
 */

const SEVERITY_STYLE: Record<Severity, { chip: string; rail: string; label: string }> = {
  critical: {
    chip: "bg-sev-critical-wash text-sev-critical",
    rail: "bg-sev-critical",
    label: "Critical",
  },
  high: { chip: "bg-sev-high-wash text-sev-high", rail: "bg-sev-high", label: "High" },
  medium: {
    chip: "bg-sev-medium-wash text-sev-medium",
    rail: "bg-sev-medium",
    label: "Medium",
  },
  low: { chip: "bg-sev-low-wash text-sev-low", rail: "bg-sev-low", label: "Low" },
};

/**
 * Severity, or the honest absence of one.
 *
 * `aiAvailable === false` means the interpretation call failed for that signal.
 * The alert is *ungraded*, not low priority — so it gets its own violet, dashed
 * treatment rather than a position on the ramp. A dashed border reads as
 * "deliberately incomplete" where a solid grey chip reads as a fifth severity.
 *
 * Do not collapse this branch. It is the one piece of state in the product that
 * would be actively misleading if styled like its neighbours.
 */
export function SeverityChip({
  severity,
  aiAvailable = true,
  reason,
  className = "",
}: {
  severity: string;
  aiAvailable?: boolean;
  /**
   * Why this band, in two or three words — "33% discount".
   *
   * A bare "MEDIUM" gives the operator a verdict with no way to judge whether
   * they agree. Severity is computed from the size of the move, so the size is
   * the explanation, and it is already in the row. Omitted where it is not
   * genuinely derivable rather than filled with something plausible.
   */
  reason?: string | null;
  className?: string;
}) {
  if (!aiAvailable) {
    return (
      <span
        title="Automated interpretation failed for this signal, so its severity was never assessed"
        className={`inline-flex shrink-0 items-center rounded border border-dashed border-sev-unclassified px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-sev-unclassified ${className}`}
      >
        Unclassified
      </span>
    );
  }

  const style = SEVERITY_STYLE[normalizeSeverity(severity)];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wider ${style.chip} ${className}`}
    >
      {style.label}
      {reason ? (
        <span className="font-bold normal-case tracking-normal opacity-90">· {reason}</span>
      ) : null}
    </span>
  );
}

/** The coloured edge on a card or table row. Same rules as the chip. */
export function severityRail(severity: string, aiAvailable = true): string {
  if (!aiAvailable) return "bg-sev-unclassified";
  return SEVERITY_STYLE[normalizeSeverity(severity)].rail;
}

/**
 * One shape per signal, so price / promo / catalogue separate at a glance
 * without reading the label. Inline SVG deliberately — seven paths do not
 * justify an icon dependency, and these inherit `currentColor`.
 */
const SIGNAL_ICON: Record<SignalType, ReactNode> = {
  sku_price_change: (
    <>
      <path d="M8.6 2H14v5.4L7.4 14 2 8.6 8.6 2Z" />
      <circle cx="11.1" cy="4.9" r="0.9" />
    </>
  ),
  catalog_change: (
    <>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </>
  ),
  promo_discount: (
    <>
      <path d="M13 3 3 13" />
      <circle cx="4.6" cy="4.6" r="1.6" />
      <circle cx="11.4" cy="11.4" r="1.6" />
    </>
  ),
  ad_creative: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M6.8 6.3 10 8l-3.2 1.7V6.3Z" />
    </>
  ),
  review_sentiment: (
    <path d="M8 2.2 9.8 5.9l4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4L2.2 6.5l4-.6L8 2.2Z" />
  ),
  website_change: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 6.4h12" />
    </>
  ),
  newsletter: (
    <>
      <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
      <path d="m2.6 5.2 5.4 4 5.4-4" />
    </>
  ),
  inventory_status: (
    <>
      <path d="M8 2 13.5 5v6L8 14 2.5 11V5L8 2Z" />
      <path d="M2.5 5 8 8l5.5-3M8 8v6" />
    </>
  ),
};

/** `signal_type` is free text in the database, so an unknown value must render. */
const UNKNOWN_SIGNAL_ICON: ReactNode = <circle cx="8" cy="8" r="4" />;

/**
 * One hue per signal.
 *
 * Independent of severity, and that separation is the whole point: the signal
 * colour says what KIND of move this is, never how urgent it is. A price change
 * is blue whether it is trivial or critical, and the severity chip beside it
 * carries the urgency. Collapsing the two would leave the operator unable to
 * tell "a promotion" from "an emergency" at a glance.
 */
const SIGNAL_TONE: Record<SignalType, { text: string; wash: string }> = {
  sku_price_change: { text: "text-sig-price", wash: "bg-sig-price-wash" },
  promo_discount: { text: "text-sig-promo", wash: "bg-sig-promo-wash" },
  catalog_change: { text: "text-sig-catalog", wash: "bg-sig-catalog-wash" },
  website_change: { text: "text-sig-website", wash: "bg-sig-website-wash" },
  ad_creative: { text: "text-sig-newsletter", wash: "bg-sig-newsletter-wash" },
  review_sentiment: { text: "text-sig-reviews", wash: "bg-sig-reviews-wash" },
  newsletter: { text: "text-sig-newsletter", wash: "bg-sig-newsletter-wash" },
  // Shares catalog's tone rather than a new token — same precedent as
  // ad_creative sharing newsletter's: both are about a product's own state,
  // distinguished by icon and label rather than a dedicated color.
  inventory_status: { text: "text-sig-catalog", wash: "bg-sig-catalog-wash" },
};

const UNKNOWN_TONE = { text: "text-sig-unknown", wash: "bg-sig-unknown-wash" };

export function signalTone(type: string) {
  return isKnownSignalType(type) ? SIGNAL_TONE[type] : UNKNOWN_TONE;
}

export function SignalIcon({ type, className = "size-4" }: { type: string; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={`shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {isKnownSignalType(type) ? SIGNAL_ICON[type] : UNKNOWN_SIGNAL_ICON}
    </svg>
  );
}

/**
 * Icon + label in the signal's own colour.
 *
 * `badge` fills the wash behind it — used where the tag has to hold its own
 * against a severity chip; the plain form is for dense rows where two filled
 * pills side by side would fight.
 */
export function SignalTag({
  type,
  badge = false,
  className = "",
}: {
  type: string;
  badge?: boolean;
  className?: string;
}) {
  const tone = signalTone(type);
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 ${tone.text} ${
        badge ? `${tone.wash} rounded px-2 py-0.5 font-medium` : ""
      } ${className}`}
    >
      <SignalIcon type={type} className="size-3.5" />
      {signalTypeLabel(type)}
    </span>
  );
}

/** The signal's icon in a filled square — the leading mark on a detail header. */
export function SignalMark({ type, className = "size-10" }: { type: string; className?: string }) {
  const tone = signalTone(type);
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-lg ${tone.wash} ${tone.text} ${className}`}
    >
      <SignalIcon type={type} className="size-5" />
    </span>
  );
}

/**
 * before → now, the shape this product is fundamentally about.
 *
 * Renders nothing when either side is missing rather than showing an arrow with
 * a blank on one end — an empty "before" reads as "it was nothing", which for a
 * price is a very different claim from "we do not know what it was".
 */
export function BeforeAfter({
  before,
  after,
  className = "",
}: {
  before: string | null;
  after: string | null;
  className?: string;
}) {
  if (!before || !after) return null;
  return (
    <span className={`inline-flex flex-wrap items-center gap-2 ${className}`}>
      <span className="text-ink-muted line-through decoration-ink-faint/60">{before}</span>
      <svg aria-hidden viewBox="0 0 16 16" className="size-3.5 shrink-0 text-ink-faint" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M2 8h11M9 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="font-semibold text-ink">{after}</span>
    </span>
  );
}

/** A neutral outlined pill — counts, statuses, metadata. */
export function Pill({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-border-strong px-2.5 py-0.5 text-sm text-ink-muted ${className}`}
    >
      {children}
    </span>
  );
}

/** The live/reconnecting dot. A dead subscription looks exactly like a quiet day. */
export function LiveDot({ state }: { state: "live" | "connecting" | "error" }) {
  const tone =
    state === "live" ? "bg-sev-low" : state === "error" ? "bg-sev-critical" : "bg-ink-faint";
  const label = state === "live" ? "Live" : state === "error" ? "Offline" : "Connecting";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-xs font-medium text-ink-muted"
      title={
        state === "live"
          ? "Subscribed to live updates"
          : "Not receiving live updates. New alerts will appear on refresh"
      }
    >
      <span aria-hidden className={`size-1.5 rounded-full ${tone}`} />
      {label}
    </span>
  );
}
