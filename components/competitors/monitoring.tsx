"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";

import {
  addCompetitor,
  deleteCompetitor,
  setCompetitorActive,
  syncCompetitor,
  updateSignalConfig,
  runCompetitorNow,
  type CompetitorActionState,
} from "@/app/actions/competitors";
import { suggestAlternativesFor } from "@/app/actions/onboarding";
import { Panel, PanelHeading } from "@/components/page-header";
import { SuggestionList } from "@/components/competitors/suggestion-card";
import { TimeAgo } from "@/components/time-ago";
import { SignalIcon, SignalTag } from "@/components/ui/chips";
import { createClient } from "@/lib/supabase/client";
import { SIGNAL_TYPES, SIGNAL_TYPE_LABELS, isSignalLive, type SignalType } from "@/lib/signals";
import { FREE_TIER_CADENCE_HOURS } from "@/lib/tier";
import type { Alert, Competitor, CompetitorSuggestion, ScrapeRun, SignalConfig } from "@/lib/types/database";

/**
 * Who is monitored, and how often.
 *
 * The seven signals are grouped the way an operator thinks about them rather
 * than the way they are stored: what a competitor charges, what their shop
 * looks like, and what their customers are saying. The storage order is
 * alphabetical-ish and means nothing to anyone.
 *
 * A signal with no row in `signal_configs` is shown as *not collected in this
 * version* rather than hidden. Coverage the operator cannot see is coverage they
 * will assume they have — and the whole grid quietly implying seven working
 * monitors when four exist is exactly the failure this screen should prevent.
 */

const GROUPS: { label: string; signals: SignalType[] }[] = [
  { label: "Commercial", signals: ["sku_price_change", "promo_discount", "inventory_status"] },
  {
    label: "Storefront",
    signals: ["catalog_change", "website_change", "ad_creative"],
  },
  { label: "Audience", signals: ["review_sentiment", "newsletter"] },
];

const CADENCE_CHOICES = [1, 3, 6, 8, 12, 24, 48, 168] as const;

function cadenceLabel(hours: number): string {
  if (hours === 24) return "Daily";
  if (hours === 168) return "Weekly";
  if (hours % 24 === 0) return `Every ${hours / 24} days`;
  return `Every ${hours}h`;
}

export interface CompetitorRow extends Competitor {
  configs: SignalConfig[];
  latest: Alert | null;
  latestRun: ScrapeRun | null;
}

function Toggle({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <label
      className={`relative inline-flex ${disabled ? "" : "cursor-pointer"}`}
    >
      <span className="sr-only">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <span className="block h-6 w-11 rounded-full bg-border-strong transition-colors peer-checked:bg-accent peer-disabled:opacity-40 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-accent" />
      <span className="absolute left-1 top-1 size-4 rounded-full bg-surface transition-transform peer-checked:translate-x-5 peer-disabled:opacity-60" />
    </label>
  );
}

/** Same caution as isRenderableAlert in alerts-table.tsx: Realtime can deliver a partial row. */
function isRenderableScrapeRun(row: unknown): row is ScrapeRun {
  if (!row || typeof row !== "object") return false;
  const candidate = row as Partial<ScrapeRun>;
  return (
    typeof candidate.run_id === "string" && typeof candidate.status === "string"
  );
}

const ACTIVE_RUN_STATUSES = new Set<ScrapeRun["status"]>([
  "running",
  "processing",
]);

/** Whether a run is still in flight — used to disable Run Now and drive the spinner. */
function isRunActive(run: ScrapeRun | null): boolean {
  return run !== null && ACTIVE_RUN_STATUSES.has(run.status);
}

function runStatusText(run: ScrapeRun | null): string {
  if (!run) return "Never run";
  switch (run.status) {
    case "running":
      return "Starting the scrape…";
    case "processing":
      return "Processing results…";
    case "succeeded":
      return "Completed";
    case "failed":
      return "Failed";
  }
}

/**
 * Live status for one competitor's most recent scrape run — what "Run Now"
 * actually did, not just whether the click succeeded. Seeded from the
 * server-rendered row, then kept current over Realtime (supabase/11): a
 * fresh start_scrape INSERTs the row, and process_apify_run /
 * check_apify_run UPDATE it as the run moves through running -> processing ->
 * succeeded/failed.
 */
function RunProgress({
  competitorId,
  initial,
}: {
  competitorId: string;
  initial: ScrapeRun | null;
}) {
  // No effect syncs `initial` into state — callers pass key={competitorId} so
  // switching competitors remounts this fresh instead, which is also what
  // correctly resets the Realtime subscription below.
  const [run, setRun] = useState<ScrapeRun | null>(initial);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`scrape-runs-${competitorId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "scrape_runs",
          filter: `competitor_id=eq.${competitorId}`,
        },
        (payload) => {
          if (!isRenderableScrapeRun(payload.new)) return;
          const row = payload.new;
          setRun((prev) => {
            // A competitor can have more than one run in flight (Run Now while
            // the schedule also fired) — only replace state with the newest.
            if (
              prev &&
              prev.run_id !== row.run_id &&
              prev.started_at > row.started_at
            )
              return prev;
            return row;
          });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [competitorId]);

  if (!run) {
    return <span className="text-[13px] text-ink-faint">Never run</span>;
  }

  const active = isRunActive(run);

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[13px] ${
        run.status === "failed" ? "text-sev-critical" : "text-ink-faint"
      }`}
      title={run.error ?? undefined}
    >
      {active ? (
        <span
          aria-hidden
          className="size-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"
        />
      ) : null}
      {runStatusText(run)}
      {run.status === "failed" && run.error ? (
        <span className="max-w-40 truncate">— {run.error}</span>
      ) : null}
      {!active ? (
        <>
          {" · "}
          <TimeAgo iso={run.updated_at} />
        </>
      ) : null}
    </span>
  );
}

function SignalRow({
  competitorId,
  signal,
  config,
  onChanged,
  pipelineLive,
}: {
  competitorId: string;
  signal: SignalType;
  config: SignalConfig | undefined;
  onChanged: (state: CompetitorActionState) => void;
  /** Once live, cadence is locked to weekly regardless of what is stored — see lib/tier.ts. */
  pipelineLive: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useState<{
    enabled: boolean;
    hours: number;
  } | null>(null);
  const [errorOpen, setErrorOpen] = useState(false);

  // Two different absences, and they need different words.
  //
  // "Coming soon" means no workflow can produce this signal yet, so the toggle
  // is dead regardless of the row behind it — see SIGNAL_AVAILABILITY. A live
  // switch here would read as coverage and quietly become a blind spot.
  //
  // "Not provisioned" means the pipeline supports it but this competitor has no
  // config row, which is a different fix.
  if (!isSignalLive(signal) || !config) {
    const comingSoon = !isSignalLive(signal);
    return (
      <div className="hatched flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[15px] font-medium text-ink-muted">
            <SignalIcon type={signal} className="size-4" />
            {SIGNAL_TYPE_LABELS[signal]}
          </p>
          <p className="mt-0.5 text-[13px] text-ink-faint">
            {comingSoon
              ? "Coming soon · not collected yet"
              : "Not set up for this competitor"}
          </p>
        </div>
        <Toggle
          checked={false}
          disabled
          onChange={() => {}}
          label={SIGNAL_TYPE_LABELS[signal]}
        />
      </div>
    );
  }

  const enabled = optimistic?.enabled ?? config.enabled;
  const hours = pipelineLive ? FREE_TIER_CADENCE_HOURS : (optimistic?.hours ?? config.frequency_hours);

  const patch = (next: { enabled?: boolean; frequency_hours?: number }) => {
    setOptimistic({
      enabled: next.enabled ?? enabled,
      hours: next.frequency_hours ?? hours,
    });
    startTransition(async () => {
      const result = await updateSignalConfig(competitorId, signal, next);
      onChanged(result);
      // Roll back to whatever the server has if the write was rejected — a
      // toggle that stays flipped after a failed save is a lie about what is
      // being collected.
      if (!result.ok) setOptimistic(null);
    });
  };

  return (
    <div
      className={`rounded-lg border border-border px-4 py-3 transition-opacity ${
        pending ? "opacity-70" : ""
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[15px] font-medium text-ink">
            <SignalIcon type={signal} className="size-4" />
            {SIGNAL_TYPE_LABELS[signal]}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <select
              value={hours}
              disabled={!enabled || pipelineLive}
              onChange={(event) =>
                patch({ frequency_hours: Number(event.target.value) })
              }
              title={pipelineLive ? "Locked to weekly on the free tier" : undefined}
              className="rounded border border-border bg-surface px-1.5 py-0.5 text-[13px] text-ink-muted
                       disabled:opacity-50 focus:border-accent focus:outline-none"
            >
              {CADENCE_CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  {cadenceLabel(choice)}
                </option>
              ))}
            </select>
            {pipelineLive ? (
              <span className="text-[13px] text-ink-faint">free tier limit</span>
            ) : null}
            {config.last_error ? (
              <button
                type="button"
                onClick={() => setErrorOpen((open) => !open)}
                aria-expanded={errorOpen}
                className="max-w-48 truncate text-[13px] text-sev-critical underline decoration-dotted underline-offset-2 hover:text-sev-critical"
              >
                {errorOpen ? "Hide error" : "Failed — why?"}
              </button>
            ) : config.last_run_at ? (
              <span className="text-[13px] text-ink-faint">
                ran <TimeAgo iso={config.last_run_at} />
              </span>
            ) : (
              <span className="text-[13px] text-ink-faint">not run yet</span>
            )}
          </div>
        </div>
        <Toggle
          checked={enabled}
          onChange={(next) => patch({ enabled: next })}
          label={SIGNAL_TYPE_LABELS[signal]}
        />
      </div>
      {errorOpen && config.last_error ? (
        <p className="mt-2 rounded-lg bg-sev-critical-wash px-3 py-2 text-[13px] text-sev-critical">
          {config.last_error}
        </p>
      ) : null}
    </div>
  );
}

function AddCompetitor({
  onDone,
}: {
  onDone: (state: CompetitorActionState) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<CompetitorActionState | null>(null);
  const [alternatives, setAlternatives] = useState<CompetitorSuggestion[] | null>(null);
  const [findingAlternatives, startAlternativesTransition] = useTransition();

  const reset = () => {
    setState(null);
    setAlternatives(null);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          reset();
          setOpen(true);
        }}
        className="rounded-lg bg-solid px-4 py-2 text-[15px] font-medium text-solid-ink transition-colors hover:bg-solid-hover"
      >
        + Add competitor
      </button>
    );
  }

  return (
    <div className="flex w-full flex-col gap-3">
      <form
        action={(formData) =>
          startTransition(async () => {
            reset();
            const name = String(formData.get("name") ?? "").trim();
            const url = String(formData.get("url") ?? "").trim();
            const result = await addCompetitor(
              { ok: false, error: null, warning: null },
              formData,
            );
            setState(result);
            onDone(result);
            if (result.ok) {
              setOpen(false);
              return;
            }
            // "Real site, wrong platform" gets a second chance: look for a
            // same-category competitor that actually runs on Shopify, rather
            // than leaving the operator with only a dead end.
            if (result.notShopify) {
              startAlternativesTransition(async () => {
                const alt = await suggestAlternativesFor(name, url);
                setAlternatives(alt.suggestions ?? []);
              });
            }
          })
        }
        className="flex flex-wrap items-center gap-2"
      >
        <input
          name="name"
          required
          placeholder="Name"
          className="w-40 rounded-lg border border-border bg-surface px-3 py-2 text-[15px] focus:border-accent focus:outline-none"
        />
        <input
          name="url"
          required
          placeholder="https://store.com"
          className="w-56 rounded-lg border border-border bg-surface px-3 py-2 text-[15px] focus:border-accent focus:outline-none"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-solid px-4 py-2 text-[15px] font-medium text-solid-ink transition-colors hover:bg-solid-hover disabled:opacity-50"
        >
          {pending ? "Verifying store…" : "Add"}
        </button>
        <button
          type="button"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          className="rounded-lg border border-border px-3 py-2 text-[15px] text-ink-muted hover:text-ink"
        >
          Cancel
        </button>
        {state?.error ? (
          <p role="alert" className="w-full text-[15px] text-sev-critical">
            {state.error}
          </p>
        ) : null}
      </form>

      {findingAlternatives ? (
        <p className="text-[15px] text-ink-muted">Looking for a competitor in the same category we can actually monitor…</p>
      ) : null}

      {alternatives ? (
        alternatives.length ? (
          <div>
            <p className="eyebrow mb-2">Try one of these instead</p>
            <SuggestionList
              suggestions={alternatives}
              onResolved={(id) => {
                setAlternatives((prev) => prev?.filter((s) => s.id !== id) ?? null);
                onDone({ ok: true, error: null, warning: null });
                setOpen(false);
              }}
            />
          </div>
        ) : (
          <p className="text-[15px] text-ink-faint">
            No monitorable alternative turned up either. You can keep looking and add one by
            hand once you find a Shopify store.
          </p>
        )
      ) : null}
    </div>
  );
}

export function Monitoring({
  competitors,
  pipelineLive,
}: {
  competitors: CompetitorRow[];
  pipelineLive: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(
    competitors[0]?.id ?? null,
  );
  // Twenty-one toggles is a configuration screen, not a monitoring overview.
  // The contract collapses to a summary until the operator says they want to
  // change something.
  const [managing, setManaging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [deleting, startDeleteTransition] = useTransition();
  // A single click can't delete — see the confirm step below. Tracked by id so
  // switching competitors without confirming can't leave a stale "confirm?"
  // button armed against the wrong one.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const selected =
    competitors.find((c) => c.id === selectedId) ?? competitors[0] ?? null;

  const totals = useMemo(() => {
    const configs = competitors.flatMap((c) => c.configs);
    return {
      active: configs.filter((c) => c.enabled).length,
      failing: configs.filter((c) => c.enabled && c.last_error).length,
      monitored: competitors.filter((c) => c.active).length,
    };
  }, [competitors]);

  const handle = (result: CompetitorActionState) => {
    setNotice(result.error ?? result.warning ?? null);
  };

  const toggleActive = (competitor: CompetitorRow) => {
    setTogglingId(competitor.id);
    startTransition(async () => {
      handle(await setCompetitorActive(competitor.id, !competitor.active));
      setTogglingId(null);
    });
  };

  return (
    <div className="flex flex-col gap-4 px-8">
      <Panel className="p-5">
        <PanelHeading
          eyebrow="Monitoring portfolio"
          title={`${totals.monitored} active ${totals.monitored === 1 ? "competitor" : "competitors"}`}
          description="Select a competitor to review its monitoring schedule."
          aside={
            <div className="flex items-center gap-8">
              {[
                ["Active signals", totals.active],
                ["Failing", totals.failing],
              ].map(([label, value]) => (
                <div key={label as string}>
                  <p className="eyebrow">{label}</p>
                  <p className="tabular mt-1 text-xl font-semibold text-ink">
                    {value}
                  </p>
                </div>
              ))}
              <AddCompetitor onDone={handle} />
            </div>
          }
        />

        {notice ? (
          <p
            role="status"
            className="mt-4 rounded-lg bg-sev-high-wash px-3 py-2 text-[15px] text-sev-high"
          >
            {notice}
          </p>
        ) : null}

        {competitors.length === 0 ? (
          <p className="mt-6 rounded-xl border border-dashed border-border-strong p-8 text-[15px] text-ink-muted">
            No competitors yet. Add one to start collecting changes.
          </p>
        ) : (
          <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {competitors.map((competitor) => {
              const active = selected?.id === competitor.id;
              const enabledCount = competitor.configs.filter(
                (c) => c.enabled && isSignalLive(c.signal_type),
              ).length;
              return (
                <div
                  key={competitor.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedId(competitor.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedId(competitor.id);
                    }
                  }}
                  className={`cursor-pointer rounded-xl border p-4 text-left transition-colors ${
                    active
                      ? "border-accent bg-accent-wash/40"
                      : "border-border bg-surface hover:border-border-strong"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span
                      aria-hidden
                      className="grid size-10 shrink-0 place-items-center rounded-full border border-border bg-surface-sunken text-[13px] font-semibold text-ink-muted"
                    >
                      {competitor.name.slice(0, 2).toUpperCase()}
                    </span>
                    <button
                      type="button"
                      disabled={togglingId === competitor.id}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleActive(competitor);
                      }}
                      title={
                        competitor.active
                          ? "Pause monitoring"
                          : "Resume monitoring"
                      }
                      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium transition-opacity hover:opacity-80 disabled:opacity-50 ${
                        competitor.active
                          ? "bg-sev-low-wash text-sev-low"
                          : "bg-surface-sunken text-ink-faint"
                      }`}
                    >
                      <span
                        aria-hidden
                        className="size-1.5 rounded-full bg-current"
                      />
                      {togglingId === competitor.id
                        ? "…"
                        : competitor.active
                          ? "Active"
                          : "Paused"}
                    </button>
                  </div>

                  <p className="mt-3 text-base font-semibold text-ink">
                    {competitor.name}
                  </p>
                  <p className="truncate text-[13px] text-ink-faint">
                    {competitor.domain}
                  </p>
                  <p className="mt-1">
                    <RunProgress
                      key={competitor.id}
                      competitorId={competitor.id}
                      initial={competitor.latestRun}
                    />
                  </p>

                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {competitor.configs
                      .filter((c) => c.enabled && isSignalLive(c.signal_type))
                      .map((c) => (
                        <SignalTag
                          key={c.signal_type}
                          type={c.signal_type}
                          badge
                          className="text-xs"
                        />
                      ))}
                  </div>

                  <div className="mt-3 rounded-lg bg-surface-sunken px-3 py-2">
                    <p className="eyebrow">Latest change</p>
                    {competitor.latest ? (
                      <>
                        <p className="mt-1 line-clamp-2 text-[15px] font-medium text-ink">
                          {competitor.latest.summary}
                        </p>
                        <TimeAgo
                          iso={competitor.latest.created_at}
                          className="mt-0.5 block text-[13px] text-ink-faint"
                        />
                      </>
                    ) : (
                      <p className="mt-1 text-[15px] text-ink-faint">
                        Nothing collected yet
                      </p>
                    )}
                  </div>

                  <p className="tabular mt-3 flex items-center gap-2 text-[13px] text-ink-muted">
                    <span
                      aria-hidden
                      className={`size-1.5 rounded-full ${
                        competitor.configs.some(
                          (c) => c.enabled && c.last_error,
                        )
                          ? "bg-sev-critical"
                          : "bg-sev-low"
                      }`}
                    />
                    {enabledCount} signals tracked · {SIGNAL_TYPES.length - enabledCount} coming
                    soon
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {selected ? (
        <Panel className="p-5">
          <PanelHeading
            eyebrow="Monitoring contract"
            title={selected.name}
            description={`${SIGNAL_TYPES.length} defined signals, with ${
              selected.configs.filter(
                (c) => c.enabled && isSignalLive(c.signal_type),
              ).length
            } currently collected. The rest are coming soon.`}
            aside={
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setManaging((open) => !open)}
                  className="rounded-lg border border-border px-3.5 py-2 text-[15px] font-medium text-ink-muted transition-colors hover:border-border-strong hover:text-ink"
                >
                  {managing ? "Done" : "Manage monitoring"}
                </button>
                <Link
                  href={`/intelligence`}
                  className="rounded-lg bg-solid px-3.5 py-2 text-[15px] font-medium text-solid-ink transition-colors hover:bg-solid-hover"
                >
                  Open intelligence
                </Link>
              </div>
            }
          />

          {!managing ? (
            <div className="mt-5 flex flex-wrap gap-2">
              {selected.configs
                .filter((c) => c.enabled && isSignalLive(c.signal_type))
                .map((c) => (
                  <span
                    key={c.signal_type}
                    className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface-sunken px-3 py-2"
                  >
                    <SignalTag
                      type={c.signal_type}
                      className="text-[15px] font-medium"
                    />
                    <span className="text-[13px] text-ink-faint">
                      {cadenceLabel(c.frequency_hours)}
                    </span>
                  </span>
                ))}
              {SIGNAL_TYPES.filter((t) => !isSignalLive(t)).map((t) => (
                <span
                  key={t}
                  className="hatched inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-[15px] text-ink-faint"
                >
                  {SIGNAL_TYPE_LABELS[t]}
                  <span className="text-[13px]">coming soon</span>
                </span>
              ))}
            </div>
          ) : null}

          <div
            className={`mt-5 grid gap-4 lg:grid-cols-3 ${managing ? "" : "hidden"}`}
          >
            {GROUPS.map((group) => (
              <div
                key={group.label}
                className="rounded-xl border border-border p-4"
              >
                <p className="eyebrow">{group.label}</p>
                <div className="mt-3 flex flex-col gap-2">
                  {group.signals.map((signal) => (
                    <SignalRow
                      key={signal}
                      competitorId={selected.id}
                      signal={signal}
                      config={selected.configs.find(
                        (c) => c.signal_type === signal,
                      )}
                      onChanged={handle}
                      pipelineLive={pipelineLive}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-4 border-t border-border pt-4">
            <div>
              <p className="text-[15px] text-ink-muted">
                <span className="font-medium text-ink">
                  Collection health ·{" "}
                </span>
                {selected.configs.filter((c) => c.enabled && c.last_error)
                  .length === 0
                  ? `${selected.configs.filter((c) => c.enabled).length} active signals healthy`
                  : `${selected.configs.filter((c) => c.enabled && c.last_error).length} failing`}
              </p>
              <p className="mt-1">
                <RunProgress
                  key={selected.id}
                  competitorId={selected.id}
                  initial={selected.latestRun}
                />
              </p>
            </div>

            <div className="ml-auto flex items-center gap-3">
              <button
                type="button"
                disabled={
                  pending || !selected.active || isRunActive(selected.latestRun)
                }
                onClick={() =>
                  startTransition(async () =>
                    handle(await runCompetitorNow(selected.id)),
                  )
                }
                className="rounded-lg border border-border px-3.5 py-2 text-[15px] font-medium text-ink-muted transition-colors hover:border-border-strong hover:text-ink disabled:opacity-50"
                title={
                  !selected.active
                    ? "Competitor is paused"
                    : isRunActive(selected.latestRun)
                      ? "A run is already in progress"
                      : "Run a scrape now"
                }
              >
                Run now
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  startTransition(async () =>
                    handle(await syncCompetitor(selected.id)),
                  )
                }
                className="rounded-lg border border-border px-3.5 py-2 text-[15px] font-medium text-ink-muted transition-colors hover:border-border-strong hover:text-ink disabled:opacity-50"
                title="Retry setting the monitoring schedule — use this only if a signal or pause change reported that the schedule failed to save"
              >
                Re-sync schedule
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  startTransition(async () =>
                    handle(
                      await setCompetitorActive(selected.id, !selected.active),
                    ),
                  )
                }
                className={
                  selected.active
                    ? "rounded-lg border border-border px-3.5 py-2 text-[15px] font-medium text-ink-muted transition-colors hover:border-border-strong hover:text-ink disabled:opacity-50"
                    : "rounded-lg bg-solid px-3.5 py-2 text-[15px] font-medium text-solid-ink transition-colors hover:bg-solid-hover disabled:opacity-50"
                }
                title={
                  selected.active
                    ? "Stop scraping this competitor until resumed"
                    : "Start scraping this competitor again on its schedule"
                }
              >
                {selected.active ? "Pause monitoring" : "Resume monitoring"}
              </button>
              {confirmDeleteId === selected.id ? (
                <>
                  <span className="text-[15px] text-sev-critical">
                    Delete for good?
                  </span>
                  <button
                    type="button"
                    disabled={deleting}
                    onClick={() =>
                      startDeleteTransition(async () => {
                        const result = await deleteCompetitor(selected.id);
                        handle(result);
                        if (result.ok) {
                          setConfirmDeleteId(null);
                          setSelectedId(null);
                        }
                      })
                    }
                    className="rounded-lg bg-sev-critical px-3.5 py-2 text-[15px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {deleting ? "Deleting…" : "Confirm delete"}
                  </button>
                  <button
                    type="button"
                    disabled={deleting}
                    onClick={() => setConfirmDeleteId(null)}
                    className="rounded-lg border border-border px-3.5 py-2 text-[15px] text-ink-muted hover:text-ink disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={pending || deleting}
                  onClick={() => setConfirmDeleteId(selected.id)}
                  className="rounded-lg border border-border px-3.5 py-2 text-[15px] font-medium text-sev-critical transition-colors hover:border-sev-critical disabled:opacity-50"
                  title="Stop monitoring and remove this competitor entirely — its alerts are kept"
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
