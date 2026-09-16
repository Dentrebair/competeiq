import type { ReactNode } from "react";

import { BeforeAfter } from "@/components/ui/chips";
import { formatDelta, formatPrice } from "@/lib/format";
import type { Alert } from "@/lib/types/database";

/**
 * The five blocks every insight is made of.
 *
 * One structure, used identically on Overview, Alerts and Intelligence:
 *
 *   What changed       the competitor's move, one line
 *   Evidence           before → after, the checkable fact
 *   Why it matters     what it does to this business
 *   Suggested decisions  two postures, each with its cost
 *   Trade-off          what the chosen posture gives up
 *
 * Before this, the same information appeared as a paragraph on one screen, a
 * table cell on another, and a bulleted list on a third — so the operator had
 * to re-learn the layout on every page. Naming the blocks once means the answer
 * to "where is the evidence" is the same everywhere.
 *
 * Every block renders nothing when its data is absent. That is deliberate and
 * it is the rule that keeps this honest: an "Evidence" heading over an empty
 * space claims we looked and found none, which is a different statement from
 * "this signal does not record a before value".
 */

/**
 * A colour per section heading.
 *
 * The five blocks always appear in the same order, so the colour is a second
 * way to find your place without reading: evidence is always teal, the business
 * meaning is always accent, the AI reading is always violet. It reinforces the
 * order rather than decorating it, which is why the map is fixed rather than a
 * free `tone` prop that each call site could set differently.
 */
const BLOCK_TONE: Record<string, string> = {
  "What changed": "text-sig-price",
  Evidence: "text-sig-website",
  "Why it matters": "text-accent",
  "Business risk": "text-sev-high",
  "Likely meaning": "text-sig-newsletter",
  "Suggested response": "text-sig-promo",
  "Suggested decisions": "text-sig-promo",
  "Questions to discuss": "text-sig-reviews",
};

export function InsightBlock({
  label,
  children,
  className = "",
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const tone = BLOCK_TONE[label] ?? "text-ink-faint";
  return (
    <div className={className}>
      <p className={`eyebrow ${tone}`}>{label}</p>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

/**
 * Prose split into points.
 *
 * The impact and deeper-reading fields come back as two or three sentences, and
 * as a block of text the second point is routinely skipped. Each sentence is
 * usually a separate claim, so each gets its own line.
 *
 * Split on sentence ends only where the next character starts a new sentence,
 * so "$21.99." and "12.5%." do not break a line in half. A single sentence
 * renders as a paragraph, because one bullet is not a list.
 */
export function SentenceList({
  text,
  className = "",
  tone = "text-ink",
}: {
  text: string;
  className?: string;
  tone?: string;
}) {
  const sentences = text
    .split(/(?<=[.!?])\s+(?=[A-Z"'‘“])/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (sentences.length <= 1) {
    return <p className={`text-base leading-relaxed ${tone} ${className}`}>{text}</p>;
  }

  return (
    <ul className={`flex flex-col gap-2 ${className}`}>
      {sentences.map((sentence, index) => (
        <li key={index} className={`flex gap-2.5 text-base leading-relaxed ${tone}`}>
          <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-current opacity-40" />
          <span>{sentence}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Evidence: before → after, plus the delta.
 *
 * Returns null unless both sides are known. Only price and promo signals carry
 * machine-readable values today — a catalogue or copy change has no stored
 * "before", and drawing an arrow with a blank on one end would read as "it was
 * nothing", which for a price is a claim we cannot make.
 */
/**
 * The full evidence block: the figures, then the description as points.
 *
 * The description is two sentences of prose and was being read as one, the same
 * problem the impact field had. Same treatment, for the same reason: each
 * sentence is a separate claim about what happened.
 */
export function EvidenceBody({
  alert,
  size = "base",
  className = "",
}: {
  alert: Alert;
  size?: "base" | "lg";
  className?: string;
}) {
  const hasFigures =
    typeof alert.previous_price === "number" && typeof alert.current_price === "number";

  return (
    <div className={`flex flex-col gap-2.5 ${className}`}>
      {hasFigures ? <EvidenceLine alert={alert} size={size} /> : null}
      <SentenceList text={alert.summary} tone="text-ink-muted" />
      {!hasFigures ? (
        <p className="text-sm text-ink-faint">
          No before and after value is recorded for this signal type, so the description above is
          the full evidence.
        </p>
      ) : null}
    </div>
  );
}

export function EvidenceLine({ alert, size = "base" }: { alert: Alert; size?: "base" | "lg" }) {
  const before = formatPrice(alert.previous_price, alert.currency);
  const after = formatPrice(alert.current_price, alert.currency);
  const delta = formatDelta(alert.delta_pct);
  if (!before || !after) return null;

  const dropped = typeof alert.delta_pct === "number" && alert.delta_pct < 0;

  return (
    <p
      className={`tabular flex flex-wrap items-baseline gap-x-2.5 gap-y-1 ${
        size === "lg" ? "text-xl" : "text-base"
      }`}
    >
      <BeforeAfter before={before} after={after} />
      {/*
        The percentage is the number the operator scans for, so it carries the
        most weight in the line: bold, and on its own wash so it separates from
        the two prices either side of it rather than reading as a third figure.
      */}
      {delta ? (
        <span
          className={`rounded px-1.5 py-0.5 font-bold ${
            size === "lg" ? "text-[17px]" : "text-base"
          } ${dropped ? "bg-sev-critical-wash text-sev-critical" : "bg-sev-low-wash text-sev-low"}`}
        >
          {delta}
        </span>
      ) : null}
      {alert.product_title && alert.signal_type !== "catalog_change" ? (
        <span className={`font-medium text-ink-muted ${size === "lg" ? "text-base" : "text-base"}`}>
          {alert.product_title}
        </span>
      ) : null}
    </p>
  );
}

/**
 * Why it matters.
 *
 * `impact` is written by WF-02 and is frequently null — the interpretation may
 * have failed, or the alert predates the field. Both cases say so rather than
 * showing an empty heading, and they say *different* things, because "the
 * analysis failed" and "nobody has asked for depth yet" lead the operator to
 * different next actions.
 */
export function WhyItMatters({ alert, className = "" }: { alert: Alert; className?: string }) {
  if (alert.impact) {
    return (
      <InsightBlock label="Why it matters" className={className}>
        <SentenceList text={alert.impact} />
      </InsightBlock>
    );
  }

  return (
    <InsightBlock label="Why it matters" className={className}>
      <p className="text-base leading-relaxed text-ink-faint">
        {alert.ai_available
          ? "Not yet read against your own catalogue. Generate decision options below to do that."
          : "Automated interpretation failed for this signal, so it has no severity or impact reading. The evidence above is unaffected."}
      </p>
    </InsightBlock>
  );
}

/**
 * Business risk, stated from what is actually known.
 *
 * Severity is computed in WF-02 from the size of the move, so the size is the
 * reason — this pairs the band with the figure that produced it rather than
 * inventing a separate risk assessment nothing measured.
 */
export function RiskLine({ alert, reason }: { alert: Alert; reason: string | null }) {
  if (!alert.ai_available) {
    return (
      <p className="text-base text-ink-faint">
        Not assessed. The interpretation for this signal did not complete.
      </p>
    );
  }

  const severity = alert.severity.toLowerCase();
  const tone =
    severity === "critical"
      ? "text-sev-critical"
      : severity === "high"
        ? "text-sev-high"
        : severity === "medium"
          ? "text-sev-medium"
          : "text-sev-low";

  const plain: Record<string, string> = {
    critical: "Needs immediate review",
    high: "Business impact likely",
    medium: "Review soon",
    low: "Watch only",
  };

  return (
    <p className="text-base leading-relaxed">
      <span className={`font-semibold capitalize ${tone}`}>{severity}</span>
      <span className="text-ink-muted"> · {plain[severity] ?? "Unrated"}</span>
      {reason ? <span className="text-ink-faint"> · {reason}</span> : null}
    </p>
  );
}
