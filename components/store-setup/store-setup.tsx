"use client";

import { useState, useTransition } from "react";

import {
  acceptSuggestion,
  dismissSuggestion,
  readStoreDraft,
  saveBrandProfile,
  suggestCompetitors,
  type BrandProfileDraft,
} from "@/app/actions/onboarding";
import { Panel, PanelHeading } from "@/components/page-header";
import { formatPrice } from "@/lib/format";
import type { BrandProfile, CompetitorSuggestion } from "@/lib/types/database";

/**
 * Store setup — one URL, then a review.
 *
 * This replaces the ten-field profile form nobody fills in. The catalogue is
 * read from the operator's own storefront, the softer things are inferred, and
 * the operator confirms.
 *
 * The tier is the load-bearing idea and it is surfaced everywhere: at
 * `confirmed` the figures came from a real product feed and the review is a
 * formality; at `inferred` they were read off marketing copy and the review is
 * the entire point of the screen. Presenting those identically would launder a
 * guess into a fact, and every prompt downstream would then reason from it.
 */

const TIER: Record<
  NonNullable<BrandProfileDraft["catalogueSource"]>,
  { label: string; tone: string; blurb: string }
> = {
  confirmed: {
    label: "Confirmed",
    tone: "bg-sev-low-wash text-sev-low",
    blurb: "Read directly from your store's product feed. These figures are exact.",
  },
  page_data: {
    label: "Read from your pages",
    tone: "bg-sev-medium-wash text-sev-medium",
    blurb:
      "No product feed, so this was read from a sample of your product pages. Close, but check the numbers.",
  },
  inferred: {
    label: "Inferred",
    tone: "bg-sev-high-wash text-sev-high",
    blurb:
      "Your catalogue could not be read directly, so this was interpreted from your site. Please correct anything wrong, because everything downstream reasons from it.",
  },
};

function Field({
  label,
  value,
  onChange,
  hint,
  multiline,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  hint?: string;
  multiline?: boolean;
}) {
  const shared =
    "mt-1.5 w-full rounded-lg border border-border bg-surface px-3 py-2 text-base text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none";
  return (
    <label className="block">
      <span className="eyebrow">{label}</span>
      {multiline ? (
        <textarea rows={3} value={value} onChange={(e) => onChange(e.target.value)} className={shared} />
      ) : (
        <input value={value} onChange={(e) => onChange(e.target.value)} className={shared} />
      )}
      {hint ? <span className="mt-1 block text-[13px] text-ink-faint">{hint}</span> : null}
    </label>
  );
}

function SuggestionCard({
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
          <p className="truncate text-[13px] text-ink-faint">{suggestion.domain}</p>
        </div>
        <span className="shrink-0 rounded-full bg-sev-low-wash px-2 py-0.5 text-xs font-medium text-sev-low">
          Verified
        </span>
      </div>

      {/* The evidence line is what makes a wrong suggestion cheap to reject. */}
      {bits.length ? <p className="mt-2 text-[13px] text-ink-muted">{bits.join(" · ")}</p> : null}

      {suggestion.rationale ? (
        <p className="mt-2 text-[15px] leading-relaxed text-ink-muted">{suggestion.rationale}</p>
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
          className="rounded-lg bg-solid px-3 py-1.5 text-[15px] font-medium text-solid-ink transition-colors hover:bg-solid-hover disabled:opacity-50"
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
          className="text-[15px] text-ink-muted underline-offset-4 hover:text-ink hover:underline disabled:opacity-50"
        >
          Not a competitor
        </button>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-[15px] text-sev-critical">
          {error}
        </p>
      ) : null}
    </article>
  );
}

export function StoreSetup({
  profile,
  initialSuggestions,
}: {
  profile: BrandProfile | null;
  initialSuggestions: CompetitorSuggestion[];
}) {
  const [url, setUrl] = useState(profile?.url ?? "");
  const [draft, setDraft] = useState<BrandProfileDraft | null>(null);
  const [saved, setSaved] = useState(Boolean(profile));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState(initialSuggestions);
  const [rejected, setRejected] = useState<{ domain: string; reason: string }[]>([]);
  const [reading, startReading] = useTransition();
  const [savingProfile, startSaving] = useTransition();
  const [suggesting, startSuggesting] = useTransition();

  const read = () =>
    startReading(async () => {
      setError(null);
      setNotice(null);
      const result = await readStoreDraft(url);
      if (result.ok) {
        setDraft(result.draft);
        setSaved(false);
      } else {
        setError(result.error);
      }
    });

  const save = () => {
    if (!draft) return;
    startSaving(async () => {
      const result = await saveBrandProfile(draft);
      if (result.ok) {
        setSaved(true);
        setNotice("Saved. Every recommendation from here on is written against this.");
      } else {
        setError(result.error ?? "Could not save.");
      }
    });
  };

  const findCompetitors = () =>
    startSuggesting(async () => {
      setError(null);
      const result = await suggestCompetitors();
      if (!result.ok) {
        setError(result.error ?? "Could not look for competitors.");
        return;
      }
      setSuggestions(result.suggestions ?? []);
      setRejected(result.rejected ?? []);
    });

  const tier = draft?.catalogueSource ?? profile?.catalogue_source ?? null;
  const tierInfo = tier ? TIER[tier] : null;

  return (
    <div className="flex flex-col gap-4 px-8">
      <Panel className="p-5">
        <PanelHeading
          eyebrow="Your business"
          title={profile || draft ? "Your store" : "Start with your store address"}
          description={
            profile || draft
              ? "Everything the product recommends is written against this. Correct anything wrong."
              : "One address. We read your catalogue and work out the rest, with no form to fill in."
          }
        />

        <div className="mt-5 flex flex-wrap items-end gap-3">
          <label className="min-w-[280px] flex-1">
            <span className="eyebrow">Store address</span>
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="yourstore.com"
              className="mt-1.5 w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-base
                         text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
            />
          </label>
          <button
            type="button"
            onClick={read}
            disabled={reading || !url.trim()}
            className="rounded-lg bg-solid px-4 py-2.5 text-[15px] font-medium text-solid-ink
                       transition-colors hover:bg-solid-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {reading ? "Reading your store…" : profile ? "Re-read my store" : "Read my store"}
          </button>
        </div>

        {reading ? (
          <p className="mt-3 text-[15px] text-ink-muted">
            Looking for a product feed, then falling back to your product pages. A few seconds.
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="mt-4 rounded-lg bg-sev-critical-wash px-3 py-2 text-[15px] text-sev-critical">
            {error}
          </p>
        ) : null}

        {notice ? (
          <p role="status" className="mt-4 rounded-lg bg-sev-low-wash px-3 py-2 text-[15px] text-sev-low">
            {notice}
          </p>
        ) : null}
      </Panel>

      {draft ? (
        <Panel className="p-5">
          <PanelHeading
            eyebrow="Review"
            title="Check this before saving"
            description={draft.note}
            aside={
              tierInfo ? (
                <span className={`rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-wider ${tierInfo.tone}`}>
                  {tierInfo.label}
                </span>
              ) : null
            }
          />

          {tierInfo ? (
            <p
              className={`mt-4 rounded-lg px-3 py-2 text-[15px] ${
                tier === "inferred" ? "bg-sev-high-wash text-sev-high" : "bg-surface-sunken text-ink-muted"
              }`}
            >
              {tierInfo.blurb}
            </p>
          ) : null}

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <Field
              label="Brand name"
              value={draft.name ?? ""}
              onChange={(name) => setDraft({ ...draft, name })}
            />
            <Field
              label="Categories"
              value={draft.categories.join(", ")}
              onChange={(value) =>
                setDraft({
                  ...draft,
                  categories: value.split(",").map((c) => c.trim()).filter(Boolean),
                })
              }
              hint="What you sell. Promotional tags and campaign names have been filtered out."
            />
            <Field
              label="Audience"
              value={draft.audience ?? ""}
              onChange={(audience) => setDraft({ ...draft, audience })}
              hint="Always inferred, because no storefront publishes this."
              multiline
            />
            <Field
              label="Positioning"
              value={draft.positioning ?? ""}
              onChange={(positioning) => setDraft({ ...draft, positioning })}
              hint="Always inferred."
              multiline
            />
          </div>

          <dl className="mt-5 flex flex-wrap gap-8 border-t border-border pt-4">
            {[
              ["Platform", draft.platform],
              ["Products", draft.productCount === null ? "not counted" : String(draft.productCount)],
              [
                "Price range",
                draft.priceMin !== null && draft.priceMax !== null
                  ? `${formatPrice(draft.priceMin, draft.currency)} – ${formatPrice(draft.priceMax, draft.currency)}`
                  : "not readable",
              ],
            ].map(([label, value]) => (
              <div key={label as string}>
                <dt className="eyebrow">{label}</dt>
                <dd className="tabular mt-1 text-[15px] text-ink">{value || "–"}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-5 flex items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={savingProfile}
              className="rounded-lg bg-solid px-4 py-2.5 text-[15px] font-medium text-solid-ink transition-colors hover:bg-solid-hover disabled:opacity-50"
            >
              {savingProfile ? "Saving…" : "Save profile"}
            </button>
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="text-[15px] text-ink-muted underline-offset-4 hover:text-ink hover:underline"
            >
              Discard
            </button>
          </div>
        </Panel>
      ) : profile ? (
        <Panel className="p-5">
          <PanelHeading
            eyebrow="Saved profile"
            title={profile.name ?? profile.url}
            aside={
              tierInfo ? (
                <span className={`rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-wider ${tierInfo.tone}`}>
                  {tierInfo.label}
                </span>
              ) : null
            }
          />
          {/*
            The caveat travels with the saved profile, not just the review step.
            A badge alone is a label; the sentence is what stops someone reading
            an inferred price band as measured six weeks later.
          */}
          {tierInfo ? (
            <p
              className={`mt-4 rounded-lg px-3 py-2 text-[15px] ${
                (profile.catalogue_source ?? null) === "inferred"
                  ? "bg-sev-high-wash text-sev-high"
                  : "bg-surface-sunken text-ink-muted"
              }`}
            >
              {tierInfo.blurb}
            </p>
          ) : null}

          <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Categories", profile.categories.join(", ") || "–"],
              ["Products", profile.product_count === null ? "not counted" : String(profile.product_count)],
              [
                "Price range",
                profile.price_min !== null && profile.price_max !== null
                  ? `${formatPrice(profile.price_min, profile.currency)} – ${formatPrice(profile.price_max, profile.currency)}`
                  : "not readable",
              ],
              ["Audience", profile.audience ?? "–"],
            ].map(([label, value]) => (
              <div key={label as string}>
                <dt className="eyebrow">{label}</dt>
                <dd className="mt-1 text-[15px] leading-relaxed text-ink">{value}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      ) : null}

      {saved || profile ? (
        <Panel className="p-5">
          <PanelHeading
            eyebrow="Competitors"
            title="Who you might want to watch"
            description="Every suggestion is checked before it is offered. If we could not read its catalogue, it does not appear."
            aside={
              <button
                type="button"
                onClick={findCompetitors}
                disabled={suggesting}
                className="rounded-lg border border-border px-3.5 py-2 text-[15px] font-medium text-ink-muted transition-colors hover:border-border-strong hover:text-ink disabled:opacity-50"
              >
                {suggesting ? "Looking…" : "Find competitors"}
              </button>
            }
          />

          {suggestions.length ? (
            <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {suggestions.map((suggestion) => (
                <SuggestionCard
                  key={suggestion.id}
                  suggestion={suggestion}
                  onResolved={(id) => setSuggestions((prev) => prev.filter((s) => s.id !== id))}
                />
              ))}
            </div>
          ) : (
            <p className="mt-5 rounded-xl border border-dashed border-border-strong p-6 text-[15px] text-ink-muted">
              {suggesting
                ? "Searching, then checking each candidate is actually monitorable."
                : "No open suggestions. Use Find competitors to look for more."}
            </p>
          )}

          {/*
            Rejected candidates are shown rather than silently dropped. "We found
            six, four are monitorable" is a more honest report than four cards
            appearing from nowhere — and the reasons are often useful.
          */}
          {rejected.length ? (
            <div className="mt-4 border-t border-border pt-4">
              <p className="eyebrow">Proposed but not monitorable</p>
              <ul className="mt-2 flex flex-col gap-1">
                {rejected.map((entry) => (
                  <li key={entry.domain} className="text-[13px] text-ink-faint">
                    <span className="font-medium text-ink-muted">{entry.domain}</span> — {entry.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Panel>
      ) : null}
    </div>
  );
}
