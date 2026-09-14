"use client";

import { useChat } from "@/components/chat-provider";
import type { AlertAlternative } from "@/lib/types/database";

/**
 * "Business decisions to consider" — the block that turns an alert into a choice.
 *
 * The tradeoff line is the load-bearing part. Two options without stated costs
 * are two suggestions, and the operator has no basis for picking; naming what
 * each one gives up is what makes it a decision. If a tradeoff is missing the
 * card says so rather than quietly rendering a shorter card, because a silently
 * absent tradeoff is indistinguishable from an option that costs nothing.
 *
 * Renders nothing at all when there are no alternatives. An empty
 * "decisions to consider" panel implies the model considered and found none,
 * which is a different claim from "nobody has asked yet".
 */
export function DecisionOptions({
  alternatives,
  subject,
  alertId,
  digestId,
  columns = 2,
  className = "",
}: {
  alternatives: AlertAlternative[];
  /** Named in the chat header, so the conversation is visibly anchored. */
  subject: string;
  alertId?: number;
  digestId?: string;
  columns?: 1 | 2;
  className?: string;
}) {
  const { openChat } = useChat();

  if (!alternatives?.length) return null;

  return (
    <div
      className={`rounded-xl border border-accent-line bg-accent-wash/60 p-4 ${className}`}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-accent">
          <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 1.8a4.2 4.2 0 0 0-2.4 7.6c.5.4.8 1 .8 1.6v.5h3.2v-.5c0-.6.3-1.2.8-1.6A4.2 4.2 0 0 0 8 1.8Z" />
            <path d="M6.6 13.6h2.8M7 15h2" />
          </svg>
          Business decisions to consider
        </p>
        <span className="tabular text-[13px] text-ink-faint">
          {alternatives.length} {alternatives.length === 1 ? "perspective" : "perspectives"}
        </span>
      </div>

      <div className={`grid gap-3 ${columns === 2 ? "md:grid-cols-2" : ""}`}>
        {alternatives.map((alternative, index) => (
          <article
            key={`${alternative.approach}-${index}`}
            className="flex flex-col rounded-lg border border-border bg-surface p-4"
          >
            <span className="mb-2.5 inline-flex w-fit rounded bg-accent-wash px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-accent">
              Option {index + 1}
            </span>

            <h4 className="text-base font-semibold leading-snug text-ink">
              {alternative.approach}
            </h4>

            {alternative.action ? (
              <p className="mt-1.5 text-[15px] leading-relaxed text-ink-muted">{alternative.action}</p>
            ) : null}

            <p className="mt-3 border-t border-border pt-3 text-[13px] leading-relaxed text-ink-muted">
              <span className="font-semibold text-ink">Trade-off: </span>
              {alternative.tradeoff || (
                <span className="italic text-ink-faint">not stated for this option</span>
              )}
            </p>

            <button
              type="button"
              onClick={() =>
                openChat({
                  alertId,
                  digestId,
                  anchor: "alternative",
                  subject,
                  suggestions: [
                    `What would "${alternative.approach}" cost me in practice?`,
                    "Which of these two fits my catalogue better?",
                    "What would change your recommendation?",
                  ],
                })
              }
              className="mt-3 inline-flex items-center gap-1.5 self-start text-[15px] font-medium text-accent
                         underline-offset-4 transition-colors hover:text-accent-hover hover:underline"
            >
              <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 9.4a2 2 0 0 1-2 2H6l-3.2 2.4V4.6a2 2 0 0 1 2-2h7.2a2 2 0 0 1 2 2Z" />
              </svg>
              Discuss
            </button>
          </article>
        ))}
      </div>
    </div>
  );
}
