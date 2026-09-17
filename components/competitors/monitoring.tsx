"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useState, useTransition } from "react";

import {
  addCompetitor,
  deleteCompetitor,
  setCompetitorActive,
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
import { fastestEnabledFrequency } from "@/lib/scheduling";
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
      <span className="block h-7 w-12 rounded-full bg-border-strong shadow-inner transition-colors peer-checked:bg-accent peer-disabled:opacity-40 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent" />
      <span className="absolute left-1 top-1 size-5 rounded-full bg-surface shadow-sm transition-transform peer-checked:translate-x-5 peer-disabled:opacity-60" />
    </label>
  );
}

function RunIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={className} fill="currentColor">
      <path d="M4 2.8v10.4a.8.8 0 0 0 1.2.7l8.4-5.2a.8.8 0 0 0 0-1.4L5.2 2.1A.8.8 0 0 0 4 2.8Z" />
    </svg>
  );
}

function PauseIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={className} fill="currentColor">
      <rect x="3.3" y="2.5" width="3.2" height="11" rx="1" />
      <rect x="9.5" y="2.5" width="3.2" height="11" rx="1" />
    </svg>
  );
}

function TrashIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 4.5h11M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M6.5 7.5v4M9.5 7.5v4M3.5 4.5l.6 8.2a1 1 0 0 0 1 .9h5.8a1 1 0 0 0 1-.9l.6-8.2" />
    </svg>
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

function isRenderableSignalConfig(row: unknown): row is SignalConfig {
  if (!row || typeof row !== "object") return false;
  const candidate = row as Partial<SignalConfig>;
  return (
    typeof candidate.signal_type === "string" && typeof candidate.competitor_id === "string"
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

/**
 * Discrete percentage per status — there is no real progress feed from Apify
 * mid-run, so this is a stage indicator dressed as a bar, not a measurement.
 * running/processing get fixed rungs; a subtle pulse on the bar (below)
 * signals "still working" within a stage rather than implying a stalled 35%.
 */
function runProgressPercent(status: ScrapeRun["status"]): number {
  switch (status) {
    case "running":
      return 35;
    case "processing":
      return 70;
    case "succeeded":
    case "failed":
      return 100;
  }
}

/**
 * Plain words for what the pipeline is doing, not the internal status name —
 * an operator was never going to know what "processing" means. Reuses the
 * severity color ramp (orange -> yellow -> green, red on failure) rather
 * than inventing a new palette for the same "how worried should I be" scale.
 */
/**
 * A "failed" run gets a specific reason when one is known — Apify's own
 * literal word (via scrape_runs.apify_status, supabase/18) rather than a
 * single generic "Error" for every kind of failure. Null apify_status means
 * Apify itself succeeded and our own processing failed afterward (empty
 * dataset, Claude errors) — that's still just "Error", since the fault is
 * ours, not something Apify reported.
 */
function failureLabel(apifyStatus: string | null): string {
  switch (apifyStatus) {
    case "TIMED-OUT":
      return "Timed out";
    case "ABORTED":
      return "Aborted";
    case "UNREACHABLE":
      return "Connection error";
    case "HUNG":
      return "Stalled";
    case "FAILED":
    default:
      return "Error";
  }
}

function runStageLabel(run: ScrapeRun): string {
  switch (run.status) {
    case "running":
      return "Scraping data";
    case "processing":
      return "Digest";
    case "succeeded":
      return "Finished";
    case "failed":
      return failureLabel(run.apify_status);
  }
}

function runStageColor(status: ScrapeRun["status"]): { bar: string; text: string } {
  switch (status) {
    case "running":
      return { bar: "bg-sev-high", text: "text-sev-high" };
    case "processing":
      return { bar: "bg-sev-medium", text: "text-sev-medium" };
    case "succeeded":
      return { bar: "bg-sev-low", text: "text-sev-low" };
    case "failed":
      return { bar: "bg-sev-critical", text: "text-sev-critical" };
  }
}

/**
 * The competitor's own cadence, exactly as the real schedule computes it
 * (lib/scheduling.ts, reused directly — not reimplemented) — the fastest
 * enabled live signal, clamped to the free-tier weekly floor once the
 * pipeline is live. Null means no schedule exists at all (nothing enabled).
 */
function effectiveCadenceHours(configs: SignalConfig[], pipelineLive: boolean): number | null {
  const fastest = fastestEnabledFrequency(
    configs.map((c) => ({ signal_type: c.signal_type, frequency_hours: c.frequency_hours, enabled: c.enabled })),
  );
  if (fastest === null) return null;
  return pipelineLive ? Math.max(fastest, FREE_TIER_CADENCE_HOURS) : fastest;
}

/** Ticks every second — cheap at free-tier's competitor count, and the only way "40:23" actually counts down. */
function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [enabled]);
  return now;
}

function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Live status for one competitor's most recent scrape run — what "Run Now"
 * actually did, not just whether the click succeeded. Seeded from the
 * server-rendered row, then kept current over Realtime (supabase/11): a
 * fresh start_scrape INSERTs the row, and process_apify_run (or the
 * stale-run sweep, on a lost webhook) UPDATEs it as the run moves through
 * running -> processing -> succeeded/failed.
 *
 * Pulled out of RunProgress so the run's live status can drive more than one
 * piece of UI — the progress bar AND the Run Now button's disabled/spinner
 * state both need it. Before this split, the button only knew about a run it
 * had itself started this session (via local `runningId` state): a run
 * fired by the competitor's own cron schedule updated the bar correctly but
 * left the button looking idle and clickable the whole time.
 */
function useLiveScrapeRun(competitorId: string, initial: ScrapeRun | null): ScrapeRun | null {
  // No effect syncs `initial` into state — callers pass key={competitorId} so
  // switching competitors remounts this fresh instead, which is also what
  // correctly resets the Realtime subscription below.
  const [run, setRun] = useState<ScrapeRun | null>(initial);

  // Per-instance, not just per-competitor: this hook can be used more than
  // once for the same competitor at once. Supabase's client keys channels by
  // name, so two instances sharing `scrape-runs-${competitorId}` collide —
  // the second `.on()` call throws "cannot add postgres_changes callbacks
  // ... after subscribe()" against the first instance's already-subscribed
  // channel, an uncaught error that took the whole page down. Each instance
  // getting its own unique channel name fixes that; both still filter on the
  // same competitor_id and so both still receive every update.
  const instanceId = useId();

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`scrape-runs-${competitorId}-${instanceId}`)
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
          // TEMP DEBUG LOGGING — remove once Run Now progress has been
          // verified end-to-end against a real Apify run. Logs both outcomes
          // so success and failure are equally visible in the console.
          if (row.status === "succeeded") {
            console.log("[RunProgress DEBUG] succeeded", {
              competitorId,
              runId: row.run_id,
              startedAt: row.started_at,
              updatedAt: row.updated_at,
            });
          } else if (row.status === "failed") {
            console.log("[RunProgress DEBUG] failed", {
              competitorId,
              runId: row.run_id,
              error: row.error,
              startedAt: row.started_at,
              updatedAt: row.updated_at,
            });
          }
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
  }, [competitorId, instanceId]);

  return run;
}

/** Purely presentational now — see useLiveScrapeRun for where `run` comes from. */
function RunProgress({ run }: { run: ScrapeRun | null }) {
  if (!run) {
    return (
      <div className="flex items-center gap-2">
        <div
          aria-hidden
          className="h-1.5 w-full max-w-32 rounded-full bg-surface-sunken"
        />
        <span className="shrink-0 text-sm text-ink-faint">Never run</span>
      </div>
    );
  }

  const active = isRunActive(run);
  const failed = run.status === "failed";
  const percent = runProgressPercent(run.status);
  const stage = runStageLabel(run);
  const color = runStageColor(run.status);

  return (
    <div className="flex flex-col gap-1">
      <div
        className="flex items-center gap-2"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${stage}, ${percent}%`}
      >
        <div className="h-1.5 w-full max-w-32 overflow-hidden rounded-full bg-surface-sunken">
          <div
            className={`h-full rounded-full transition-all duration-700 ease-out ${color.bar} ${
              active ? "animate-pulse" : ""
            }`}
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className={`tabular shrink-0 text-sm font-medium ${color.text}`}>{percent}%</span>
      </div>
      <span className={`text-sm font-medium ${color.text}`} title={run.error ?? undefined}>
        {stage}
        {failed && run.error ? (
          <span className="ml-1 max-w-48 truncate align-bottom font-normal">— {run.error}</span>
        ) : null}
        {!active ? (
          <>
            {" · "}
            <TimeAgo iso={run.updated_at} className="font-normal text-ink-faint" />
          </>
        ) : null}
      </span>
    </div>
  );
}

/**
 * Live signal_configs for one competitor — same Realtime pattern as
 * RunProgress (supabase/15 adds this table to the publication). Without it,
 * "N signals tracked" only updated after a full Next.js revalidate: toggling
 * a signal in "Manage monitoring" left every other rendering of that count
 * stale until something forced the page to re-fetch.
 *
 * Unlike RunProgress, this DOES resync from `initial` on a competitorId
 * change — it's used both from a component keyed per-competitor (where a
 * remount already handles this) and from the page-level signals panel, which
 * stays mounted across competitor selection and would otherwise keep
 * showing the previously-selected competitor's configs until a Realtime
 * event happened to arrive for the new one.
 */
function useLiveSignalConfigs(competitorId: string, initial: SignalConfig[]): SignalConfig[] {
  const [configs, setConfigs] = useState<SignalConfig[]>(initial);
  // React's documented pattern for "reset derived state when an id changes"
  // without an effect: compare during render and adjust synchronously. Doing
  // this in an effect instead would fire one render late and, per the
  // react-hooks lint rule, risks cascading renders.
  const [trackedId, setTrackedId] = useState(competitorId);
  if (competitorId !== trackedId) {
    setTrackedId(competitorId);
    setConfigs(initial);
  }
  const instanceId = useId();

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`signal-configs-${competitorId}-${instanceId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "signal_configs",
          filter: `competitor_id=eq.${competitorId}`,
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const old = payload.old as Partial<SignalConfig>;
            if (!old.signal_type) return;
            setConfigs((prev) => prev.filter((c) => c.signal_type !== old.signal_type));
            return;
          }
          if (!isRenderableSignalConfig(payload.new)) return;
          const row = payload.new;
          setConfigs((prev) => {
            const idx = prev.findIndex((c) => c.signal_type === row.signal_type);
            if (idx === -1) return [...prev, row];
            const next = [...prev];
            next[idx] = row;
            return next;
          });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [competitorId, instanceId]);

  return configs;
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
      <div className="hatched flex items-center justify-between gap-3 rounded-xl border border-border px-4 py-3.5">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-base font-medium text-ink-muted">
            <SignalIcon type={signal} className="size-4" />
            {SIGNAL_TYPE_LABELS[signal]}
          </p>
          <p className="mt-0.5 text-sm text-ink-faint">
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
      className={`rounded-xl border border-border px-4 py-3.5 transition-opacity ${
        pending ? "opacity-70" : ""
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-base font-medium text-ink">
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
              className="rounded border border-border bg-surface px-1.5 py-0.5 text-sm text-ink-muted
                       disabled:opacity-50 focus:border-accent focus:outline-none"
            >
              {CADENCE_CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  {cadenceLabel(choice)}
                </option>
              ))}
            </select>
            {pipelineLive ? (
              <span className="text-sm text-ink-faint">free tier limit</span>
            ) : null}
            {config.last_error ? (
              <button
                type="button"
                onClick={() => setErrorOpen((open) => !open)}
                aria-expanded={errorOpen}
                className="max-w-48 truncate text-sm text-sev-critical underline decoration-dotted underline-offset-2 hover:text-sev-critical"
              >
                {errorOpen ? "Hide error" : "Failed — why?"}
              </button>
            ) : config.last_run_at ? (
              <span className="text-sm text-ink-faint">
                ran <TimeAgo iso={config.last_run_at} />
              </span>
            ) : (
              <span className="text-sm text-ink-faint">not run yet</span>
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
        <p className="mt-2 rounded-lg bg-sev-critical-wash px-3 py-2 text-sm text-sev-critical">
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
        className="rounded-xl bg-solid px-5 py-3 text-base font-semibold text-solid-ink transition-all hover:bg-solid-hover hover:shadow-md"
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
        className="flex flex-wrap items-center gap-2.5"
      >
        <input
          name="name"
          required
          placeholder="Name"
          className="w-44 rounded-xl border border-border bg-surface px-4 py-2.5 text-base focus:border-accent focus:outline-2 focus:outline-offset-0 focus:outline-accent"
        />
        <input
          name="url"
          required
          placeholder="https://store.com"
          className="w-60 rounded-xl border border-border bg-surface px-4 py-2.5 text-base focus:border-accent focus:outline-2 focus:outline-offset-0 focus:outline-accent"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-xl bg-solid px-5 py-2.5 text-base font-semibold text-solid-ink transition-all hover:bg-solid-hover hover:shadow-md disabled:opacity-50"
        >
          {pending ? "Verifying store…" : "Add"}
        </button>
        <button
          type="button"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          className="rounded-xl border border-border px-4 py-2.5 text-base font-medium text-ink-muted transition-all hover:border-border-strong hover:text-ink"
        >
          Cancel
        </button>
        {state?.error ? (
          <p role="alert" className="w-full text-base text-sev-critical">
            {state.error}
          </p>
        ) : null}
      </form>

      {findingAlternatives ? (
        <p className="text-base text-ink-muted">Looking for a competitor in the same category we can actually monitor…</p>
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
          <p className="text-base text-ink-faint">
            No monitorable alternative turned up either. You can keep looking and add one by
            hand once you find a Shopify store.
          </p>
        )
      ) : null}
    </div>
  );
}

/** One card in the portfolio grid. Its own component so useLiveSignalConfigs — a hook — can be called per-competitor without breaking the Rules of Hooks inside a .map(). */
function CompetitorCard({
  competitor,
  selected,
  onSelect,
  onToggleActive,
  onOpenRunNow,
  onDelete,
  togglingId,
  runningId,
  pipelineLive,
}: {
  competitor: CompetitorRow;
  selected: boolean;
  onSelect: () => void;
  onToggleActive: () => void;
  /** Opens the signal picker (RunNowModal) — Run Now no longer fires directly from the card. */
  onOpenRunNow: () => void;
  onDelete: () => void;
  togglingId: string | null;
  runningId: string | null;
  pipelineLive: boolean;
}) {
  const configs = useLiveSignalConfigs(competitor.id, competitor.configs);
  const enabledCount = configs.filter((c) => c.enabled && isSignalLive(c.signal_type)).length;
  const failing = configs.some((c) => c.enabled && c.last_error);
  const run = useLiveScrapeRun(competitor.id, competitor.latestRun);
  const scrapeActive = isRunActive(run);
  const runPending = runningId === competitor.id || scrapeActive;

  // Next scheduled run countdown — purely derived, ticks live. Null in any
  // case where no schedule will actually fire: paused, or nothing enabled.
  const cadenceHours = effectiveCadenceHours(configs, pipelineLive);
  const lastRunAt = run ? new Date(run.started_at).getTime() : null;
  const nextRunAt =
    competitor.active && cadenceHours !== null && lastRunAt !== null
      ? lastRunAt + cadenceHours * 3_600_000
      : null;
  const now = useNow(nextRunAt !== null && !scrapeActive);
  const remainingMs = nextRunAt !== null ? nextRunAt - now : null;
  const togglePending = togglingId === competitor.id;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={`cursor-pointer rounded-2xl border p-5 text-left shadow-sm transition-all hover:shadow-md ${
        selected
          ? "border-accent bg-accent-wash/40 shadow-md"
          : "border-border bg-surface hover:border-border-strong"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span
          aria-hidden
          className="grid size-12 shrink-0 place-items-center rounded-full border border-border bg-surface-sunken text-base font-semibold text-ink-muted"
        >
          {competitor.name.slice(0, 2).toUpperCase()}
        </span>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={
              scrapeActive ? togglePending : !competitor.active ? togglePending : runPending
            }
            onClick={(event) => {
              event.stopPropagation();
              // One button, three real states — not three fake ones. Which
              // action a click takes depends on what's actually true right
              // now (a run genuinely in flight, or the competitor genuinely
              // paused), never on a separate "what was last clicked" flag.
              if (scrapeActive) onToggleActive(); // running -> pause
              else if (!competitor.active) onToggleActive(); // paused -> resume
              else onOpenRunNow(); // idle -> open the signal picker
            }}
            title={
              scrapeActive
                ? "A run is in progress — pause to stop future scheduled runs"
                : !competitor.active
                  ? "Paused — click to resume monitoring"
                  : "Run now"
            }
            className={`grid size-9 place-items-center rounded-full border transition-all hover:scale-105 disabled:opacity-40 ${
              scrapeActive
                ? "border-transparent bg-sev-critical-wash text-sev-critical"
                : !competitor.active
                  ? "border-border bg-surface-sunken text-ink-faint"
                  : "border-border text-ink hover:border-border-strong"
            }`}
          >
            {runPending ? (
              <span
                aria-hidden
                className="size-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"
              />
            ) : scrapeActive ? (
              <PauseIcon />
            ) : (
              <RunIcon />
            )}
            <span className="sr-only">
              {scrapeActive ? "Pause monitoring" : !competitor.active ? "Resume monitoring" : "Run now"}
            </span>
          </button>

          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
            title="Delete competitor"
            className="grid size-9 place-items-center rounded-full border border-border text-ink-muted transition-all hover:border-sev-critical hover:text-sev-critical"
          >
            <TrashIcon />
            <span className="sr-only">Delete competitor</span>
          </button>
        </div>
      </div>

      <p className="mt-4 text-lg font-semibold text-ink">{competitor.name}</p>
      <p className="truncate text-sm text-ink-faint">{competitor.domain}</p>
      <div className="mt-2">
        <RunProgress run={run} />
      </div>

      {!scrapeActive && remainingMs !== null ? (
        <p className="mt-1.5 text-sm text-ink-faint">
          {remainingMs <= 0 ? (
            "Next check due any moment"
          ) : (
            <>
              Next check in{" "}
              <span className="tabular font-medium text-ink-muted">{formatCountdown(remainingMs)}</span>
            </>
          )}
        </p>
      ) : null}

      <div className="mt-3.5 flex flex-wrap gap-1.5">
        {configs
          .filter((c) => c.enabled && isSignalLive(c.signal_type))
          .map((c) => (
            <Link
              key={c.signal_type}
              href={`/alerts?competitor=${encodeURIComponent(competitor.name)}&signal=${c.signal_type}`}
              onClick={(event) => event.stopPropagation()}
              title={`See ${SIGNAL_TYPE_LABELS[c.signal_type]} alerts for ${competitor.name}`}
              className="transition-transform hover:scale-105"
            >
              <SignalTag type={c.signal_type} badge className="text-xs" />
            </Link>
          ))}
      </div>

      <div className="mt-4 rounded-xl bg-surface-sunken px-4 py-3">
        <p className="eyebrow">Latest change</p>
        {competitor.latest ? (
          <>
            <p className="mt-1.5 line-clamp-2 text-base font-medium text-ink">
              {competitor.latest.summary}
            </p>
            <TimeAgo
              iso={competitor.latest.created_at}
              className="mt-1 block text-sm text-ink-faint"
            />
          </>
        ) : (
          <p className="mt-1.5 text-base text-ink-faint">Nothing collected yet</p>
        )}
      </div>

      <p className="tabular mt-4 flex items-center gap-2 text-sm text-ink-muted">
        <span
          aria-hidden
          className={`size-1.5 rounded-full ${failing ? "bg-sev-critical" : "bg-sev-low"}`}
        />
        {failing ? <span className="font-medium text-sev-critical">Needs attention · </span> : null}
        {enabledCount} signals tracked · {SIGNAL_TYPES.length - enabledCount} coming soon
      </p>
    </div>
  );
}

/**
 * The picker Run Now opens before it enqueues anything. Only enabled, live
 * signals are offered — a coming_soon or disabled signal produces nothing
 * from a scrape regardless of whether it's "selected". Deliberately not
 * offered on "Run in 2 min", which always previews the full schedule.
 */
function RunNowModal({
  competitor,
  pending,
  onCancel,
  onConfirm,
}: {
  competitor: CompetitorRow;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (signalTypes: SignalType[]) => void;
}) {
  const selectable = useMemo(
    () => competitor.configs.filter((c) => c.enabled && isSignalLive(c.signal_type)),
    [competitor.configs],
  );
  const [selected, setSelected] = useState<Set<SignalType>>(
    () => new Set(selectable.map((c) => c.signal_type)),
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const toggle = (type: SignalType) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-now-title"
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-border bg-surface p-6 shadow-lg"
      >
        <h2 id="run-now-title" className="text-xl font-bold text-ink">
          Run now for {competitor.name}
        </h2>
        <p className="mt-2 text-base text-ink-muted">
          Choose which signals to check for on this run.
        </p>

        <div className="mt-4 flex flex-col gap-2">
          {selectable.length === 0 ? (
            <p className="text-sm text-ink-faint">
              No signals are enabled for this competitor yet — enable one in Manage monitoring
              first.
            </p>
          ) : (
            selectable.map((c) => (
              <label
                key={c.signal_type}
                className="flex cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2.5 transition-colors hover:bg-surface-sunken"
              >
                <input
                  type="checkbox"
                  checked={selected.has(c.signal_type)}
                  onChange={() => toggle(c.signal_type)}
                  className="size-4 rounded border-border-strong accent-accent"
                />
                <SignalIcon type={c.signal_type} className="size-4 text-ink-muted" />
                <span className="text-base font-medium text-ink">
                  {SIGNAL_TYPE_LABELS[c.signal_type]}
                </span>
              </label>
            ))
          )}
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            disabled={pending}
            onClick={onCancel}
            className="rounded-xl border border-border px-4 py-2.5 text-base font-medium text-ink-muted transition-all hover:border-border-strong hover:text-ink disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={pending || selected.size === 0}
            onClick={() => onConfirm([...selected])}
            className="rounded-xl bg-solid px-4 py-2.5 text-base font-semibold text-solid-ink transition-all hover:bg-solid-hover hover:shadow-md disabled:opacity-50"
          >
            {pending
              ? "Starting…"
              : `Run ${selected.size === selectable.length ? "all" : selected.size}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteConfirmModal({
  competitor,
  deleting,
  onCancel,
  onConfirm,
}: {
  competitor: CompetitorRow;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-competitor-title"
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-border bg-surface p-6 shadow-lg"
      >
        <h2 id="delete-competitor-title" className="text-xl font-bold text-ink">
          Delete {competitor.name}?
        </h2>
        <p className="mt-2 text-base text-ink-muted">
          This stops monitoring and removes it from your list for good. Its past alerts are kept.
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            disabled={deleting}
            onClick={onCancel}
            className="rounded-xl border border-border px-4 py-2.5 text-base font-medium text-ink-muted transition-all hover:border-border-strong hover:text-ink disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={deleting}
            onClick={onConfirm}
            className="rounded-xl bg-sev-critical px-4 py-2.5 text-base font-semibold text-white transition-all hover:opacity-90 hover:shadow-md disabled:opacity-50"
          >
            {deleting ? "Deleting…" : "Delete for good"}
          </button>
        </div>
      </div>
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
  const [, startTransition] = useTransition();
  const [runningId, setRunningId] = useState<string | null>(null);
  const [deleting, startDeleteTransition] = useTransition();
  // A single click can't delete — see DeleteConfirmModal. Tracked by id so
  // switching competitors without confirming can't leave a stale modal armed
  // against the wrong one.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  // Run Now opens a signal picker rather than firing immediately — tracked
  // the same way as confirmDeleteId, by id, so it can't stay armed against
  // the wrong competitor.
  const [runNowModalId, setRunNowModalId] = useState<string | null>(null);
  const [confirmingRun, startRunConfirmTransition] = useTransition();

  const selected =
    competitors.find((c) => c.id === selectedId) ?? competitors[0] ?? null;

  // Always called, never conditionally — Rules of Hooks. A competitorId of
  // "" with no matching rows is a harmless no-op subscription when nothing
  // is selected (competitors is empty).
  const selectedConfigs = useLiveSignalConfigs(selected?.id ?? "", selected?.configs ?? []);

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

  const runNow = (competitorId: string, signalTypes: SignalType[]) => {
    setRunningId(competitorId);
    startRunConfirmTransition(async () => {
      const result = await runCompetitorNow(competitorId, signalTypes);
      handle(result);
      setRunningId(null);
      if (result.ok) setRunNowModalId(null);
    });
  };


  const competitorToDelete = competitors.find((c) => c.id === confirmDeleteId) ?? null;
  const competitorForRunNow = competitors.find((c) => c.id === runNowModalId) ?? null;

  return (
    <div className="flex flex-col gap-6 px-8">
      <Panel className="p-6">
        <PanelHeading
          eyebrow="Monitoring portfolio"
          title={`${totals.monitored} active ${totals.monitored === 1 ? "competitor" : "competitors"}`}
          description="Pick a competitor below to manage its signals."
          aside={
            <div className="flex items-center gap-8">
              {[
                ["Active signals", totals.active],
                ["Failing", totals.failing],
              ].map(([label, value]) => (
                <div key={label as string}>
                  <p className="eyebrow">{label}</p>
                  <p className="tabular mt-1 text-2xl font-bold text-ink">
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
            className="mt-4 rounded-lg bg-sev-high-wash px-3 py-2 text-base text-sev-high"
          >
            {notice}
          </p>
        ) : null}
      </Panel>

      {selected ? (
        <Panel className="p-6">
          <PanelHeading
            eyebrow="Monitoring signals"
            title={selected.name}
            description={`${SIGNAL_TYPES.length} defined signals, with ${
              selectedConfigs.filter((c) => c.enabled && isSignalLive(c.signal_type)).length
            } currently collected. The rest are coming soon.`}
            aside={
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setManaging((open) => !open)}
                  className="rounded-xl border border-border px-4 py-2.5 text-base font-semibold text-ink-muted transition-all hover:border-border-strong hover:text-ink hover:shadow-sm"
                >
                  {managing ? "Done" : "Manage monitoring"}
                </button>
                <Link
                  href={`/intelligence`}
                  className="rounded-xl bg-solid px-4 py-2.5 text-base font-semibold text-solid-ink transition-all hover:bg-solid-hover hover:shadow-md"
                >
                  Open intelligence
                </Link>
              </div>
            }
          />

          {/* Which competitor "Manage monitoring" applies to — an explicit
              choice, not just whatever card was last clicked below. */}
          {competitors.length > 1 ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {competitors.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedId(c.id)}
                  className={`rounded-full px-3.5 py-1.5 text-sm font-semibold transition-all ${
                    c.id === selected.id
                      ? "bg-solid text-solid-ink"
                      : "border border-border text-ink-muted hover:border-border-strong hover:text-ink"
                  }`}
                >
                  {c.name}
                </button>
              ))}
            </div>
          ) : null}

          {!managing ? (
            <div className="mt-5 flex flex-wrap gap-2">
              {selectedConfigs
                .filter((c) => c.enabled && isSignalLive(c.signal_type))
                .map((c) => (
                  <Link
                    key={c.signal_type}
                    href={`/alerts?competitor=${encodeURIComponent(selected.name)}&signal=${c.signal_type}`}
                    title={`See ${SIGNAL_TYPE_LABELS[c.signal_type]} alerts for ${selected.name}`}
                    className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface-sunken px-3 py-2 transition-colors hover:border-border-strong"
                  >
                    <SignalTag
                      type={c.signal_type}
                      className="text-base font-medium"
                    />
                    <span className="text-sm text-ink-faint">
                      {cadenceLabel(c.frequency_hours)}
                    </span>
                  </Link>
                ))}
              {SIGNAL_TYPES.filter((t) => !isSignalLive(t)).map((t) => (
                <span
                  key={t}
                  className="hatched inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-base text-ink-faint"
                >
                  {SIGNAL_TYPE_LABELS[t]}
                  <span className="text-sm">coming soon</span>
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
                className="rounded-xl border border-border p-5"
              >
                <p className="eyebrow">{group.label}</p>
                <div className="mt-3.5 flex flex-col gap-2.5">
                  {group.signals.map((signal) => (
                    <SignalRow
                      key={signal}
                      competitorId={selected.id}
                      signal={signal}
                      config={selectedConfigs.find(
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
        </Panel>
      ) : null}

      <Panel className="p-6">
        <PanelHeading eyebrow="Competitors" title="Your portfolio" />

        {competitors.length === 0 ? (
          <p className="mt-6 rounded-xl border border-dashed border-border-strong p-8 text-base text-ink-muted">
            No competitors yet. Add one to start collecting changes.
          </p>
        ) : (
          <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {competitors.map((competitor) => (
              <CompetitorCard
                key={competitor.id}
                competitor={competitor}
                selected={selected?.id === competitor.id}
                onSelect={() => setSelectedId(competitor.id)}
                onToggleActive={() => toggleActive(competitor)}
                onOpenRunNow={() => setRunNowModalId(competitor.id)}
                onDelete={() => setConfirmDeleteId(competitor.id)}
                togglingId={togglingId}
                runningId={runningId}
                pipelineLive={pipelineLive}
              />
            ))}
          </div>
        )}
      </Panel>

      {competitorForRunNow ? (
        <RunNowModal
          competitor={competitorForRunNow}
          pending={confirmingRun}
          onCancel={() => setRunNowModalId(null)}
          onConfirm={(signalTypes) => runNow(competitorForRunNow.id, signalTypes)}
        />
      ) : null}

      {competitorToDelete ? (
        <DeleteConfirmModal
          competitor={competitorToDelete}
          deleting={deleting}
          onCancel={() => setConfirmDeleteId(null)}
          onConfirm={() =>
            startDeleteTransition(async () => {
              const result = await deleteCompetitor(competitorToDelete.id);
              handle(result);
              if (result.ok) {
                setConfirmDeleteId(null);
                if (selectedId === competitorToDelete.id) setSelectedId(null);
              }
            })
          }
        />
      ) : null}
    </div>
  );
}
