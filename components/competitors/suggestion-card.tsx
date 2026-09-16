"use client";

import { useState, useTransition } from "react";

import { acceptSuggestion, dismissSuggestion } from "@/app/actions/onboarding";
import { formatPrice } from "@/lib/format";
import type { CompetitorSuggestion } from "@/lib/types/database";

/**
 * One verified competitor suggestion, with Monitor/dismiss actions.
 *
 * Shared by Store Setup ("who you might want to watch", driven by the
 * operator's own brand profile) and the Add Competitor fallback (driven by
 * whatever URL just failed to add) — both produce the same
 * `CompetitorSuggestion` shape via `suggestCompetitors`/`suggestAlternativesFor`,
 * so they render identically.
 */
export function SuggestionCard({
  suggestion,
  onResolved,
}: {
  suggestion: CompetitorSuggestion;
  onResolved: (id: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const evidence = suggestion.evidence ?? {};

  const bits = [
    evidence.platform,
    typeof evidence.product_count === "number" ? `${evidence.product_count} products` : null,
    typeof evidence.price_min === "number" && typeof evidence.price_max === "number"
      ? `${formatPrice(evidence.price_min, evidence.currency ?? null)}–${formatPrice(
          evidence.price_max,
          evidence.currency ?? null,
        )}`
      : null,
    evidence.overlapping_categories?.length
      ? `overlaps ${evidence.overlapping_categories.slice(0, 3).join(", ")}`
      : null,
  ].filter(Boolean);

  return (
    <article className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-semibold text-ink">{suggestion.name}</p>
          <p className="truncate text-sm text-ink-faint">{suggestion.domain}</p>
        </div>
        <span className="shrink-0 rounded-full bg-sev-low-wash px-2 py-0.5 text-xs font-medium text-sev-low">
          Verified
        </span>
      </div>

      {/* The evidence line is what makes a wrong suggestion cheap to reject. */}
      {bits.length ? <p className="mt-2 text-sm text-ink-muted">{bits.join(" · ")}</p> : null}

      {suggestion.rationale ? (
        <p className="mt-2 text-base leading-relaxed text-ink-muted">{suggestion.rationale}</p>
      ) : null}

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await acceptSuggestion(suggestion.id);
              if (result.ok) onResolved(suggestion.id);
              else setError(result.error ?? "Could not add that competitor.");
            })
          }
          className="rounded-lg bg-solid px-3 py-1.5 text-base font-medium text-solid-ink transition-colors hover:bg-solid-hover disabled:opacity-50"
        >
          {pending ? "Adding…" : "Monitor this"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              await dismissSuggestion(suggestion.id);
              onResolved(suggestion.id);
            })
          }
          className="text-base text-ink-muted underline-offset-4 hover:text-ink hover:underline disabled:opacity-50"
        >
          Not a competitor
        </button>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-base text-sev-critical">
          {error}
        </p>
      ) : null}
    </article>
  );
}

export function SuggestionList({
  suggestions,
  onResolved,
}: {
  suggestions: CompetitorSuggestion[];
  onResolved: (id: string) => void;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {suggestions.map((suggestion) => (
        <SuggestionCard key={suggestion.id} suggestion={suggestion} onResolved={onResolved} />
      ))}
    </div>
  );
}
