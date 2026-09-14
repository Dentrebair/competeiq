"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";

import {
  addCompetitor,
  setCompetitorActive,
  syncCompetitor,
  updateSignalConfig,
  runCompetitorNow,
  type CompetitorActionState,
} from "@/app/actions/competitors";
import { Panel, PanelHeading } from "@/components/page-header";
import { TimeAgo } from "@/components/time-ago";
import { SignalIcon, SignalTag } from "@/components/ui/chips";
import { SIGNAL_TYPES, SIGNAL_TYPE_LABELS, isSignalLive, type SignalType } from "@/lib/signals";
import type { Alert, Competitor, SignalConfig } from "@/lib/types/database";

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
  { label: "Commercial", signals: ["sku_price_change", "promo_discount"] },
  { label: "Storefront", signals: ["catalog_change", "website_change", "ad_creative"] },
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
    <label className={`relative inline-flex ${disabled ? "" : "cursor-pointer"}`}>
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

function SignalRow({
  competitorId,
  signal,
  config,
  onChanged,
}: {
  competitorId: string;
  signal: SignalType;
  config: SignalConfig | undefined;
  onChanged: (state: CompetitorActionState) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useState<{ enabled: boolean; hours: number } | null>(null);

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
            {comingSoon ? "Coming soon · not collected yet" : "Not set up for this competitor"}
          </p>
        </div>
        <Toggle checked={false} disabled onChange={() => {}} label={SIGNAL_TYPE_LABELS[signal]} />
      </div>
    );
  }

  const enabled = optimistic?.enabled ?? config.enabled;
  const hours = optimistic?.hours ?? config.frequency_hours;

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
      className={`flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-3 transition-opacity ${
        pending ? "opacity-70" : ""
      }`}
    >
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-[15px] font-medium text-ink">
          <SignalIcon type={signal} className="size-4" />
          {SIGNAL_TYPE_LABELS[signal]}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <select
            value={hours}
            disabled={!enabled}
            onChange={(event) => patch({ frequency_hours: Number(event.target.value) })}
            className="rounded border border-border bg-surface px-1.5 py-0.5 text-[13px] text-ink-muted
                       disabled:opacity-50 focus:border-accent focus:outline-none"
          >
            {CADENCE_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {cadenceLabel(choice)}
              </option>
            ))}
          </select>
          {config.last_error ? (
            <span
              title={config.last_error}
              className="max-w-48 truncate text-[13px] text-sev-critical"
            >
              {config.last_error}
            </span>
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
  );
}

function AddCompetitor({ onDone }: { onDone: (state: CompetitorActionState) => void }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<CompetitorActionState | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg bg-solid px-4 py-2 text-[15px] font-medium text-solid-ink transition-colors hover:bg-solid-hover"
      >
        + Add competitor
      </button>
    );
  }

  return (
    <form
      action={(formData) =>
        startTransition(async () => {
          const result = await addCompetitor({ ok: false, error: null, warning: null }, formData);
          setState(result);
          onDone(result);
          if (result.ok) setOpen(false);
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
        {pending ? "Adding…" : "Add"}
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
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
  );
}

export function Monitoring({ competitors }: { competitors: CompetitorRow[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(competitors[0]?.id ?? null);
  // Twenty-one toggles is a configuration screen, not a monitoring overview.
  // The contract collapses to a summary until the operator says they want to
  // change something.
  const [managing, setManaging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const selected = competitors.find((c) => c.id === selectedId) ?? competitors[0] ?? null;

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
                  <p className="tabular mt-1 text-xl font-semibold text-ink">{value}</p>
                </div>
              ))}
              <AddCompetitor onDone={handle} />
            </div>
          }
        />

        {notice ? (
          <p role="status" className="mt-4 rounded-lg bg-sev-high-wash px-3 py-2 text-[15px] text-sev-high">
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
                <button
                  key={competitor.id}
                  type="button"
                  onClick={() => setSelectedId(competitor.id)}
                  className={`rounded-xl border p-4 text-left transition-colors ${
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
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${
                        competitor.active
                          ? "bg-sev-low-wash text-sev-low"
                          : "bg-surface-sunken text-ink-faint"
                      }`}
                    >
                      <span aria-hidden className="size-1.5 rounded-full bg-current" />
                      {competitor.active ? "Active" : "Paused"}
                    </span>
                  </div>

                  <p className="mt-3 text-base font-semibold text-ink">{competitor.name}</p>
                  <p className="truncate text-[13px] text-ink-faint">{competitor.domain}</p>

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
                      <p className="mt-1 text-[15px] text-ink-faint">Nothing collected yet</p>
                    )}
                  </div>

                  <p className="tabular mt-3 flex items-center gap-2 text-[13px] text-ink-muted">
                    <span
                      aria-hidden
                      className={`size-1.5 rounded-full ${
                        competitor.configs.some((c) => c.enabled && c.last_error)
                          ? "bg-sev-critical"
                          : "bg-sev-low"
                      }`}
                    />
                    {enabledCount} signals tracked · {7 - enabledCount} coming soon
                  </p>
                </button>
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
            description={`Seven defined signals, with ${
              selected.configs.filter((c) => c.enabled && isSignalLive(c.signal_type)).length
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
                    <SignalTag type={c.signal_type} className="text-[15px] font-medium" />
                    <span className="text-[13px] text-ink-faint">{cadenceLabel(c.frequency_hours)}</span>
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

          <div className={`mt-5 grid gap-4 lg:grid-cols-3 ${managing ? "" : "hidden"}`}>
            {GROUPS.map((group) => (
              <div key={group.label} className="rounded-xl border border-border p-4">
                <p className="eyebrow">{group.label}</p>
                <div className="mt-3 flex flex-col gap-2">
                  {group.signals.map((signal) => (
                    <SignalRow
                      key={signal}
                      competitorId={selected.id}
                      signal={signal}
                      config={selected.configs.find((c) => c.signal_type === signal)}
                      onChanged={handle}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-4 border-t border-border pt-4">
            <p className="text-[15px] text-ink-muted">
              <span className="font-medium text-ink">Collection health · </span>
              {selected.configs.filter((c) => c.enabled && c.last_error).length === 0
                ? `${selected.configs.filter((c) => c.enabled).length} active signals healthy`
                : `${selected.configs.filter((c) => c.enabled && c.last_error).length} failing`}
            </p>

            <div className="ml-auto flex items-center gap-3">
              <button
                type="button"
                disabled={pending || !selected.active}
                onClick={() =>
                  startTransition(async () => handle(await runCompetitorNow(selected.id)))
                }
                className="rounded-lg border border-border px-3.5 py-2 text-[15px] font-medium text-ink-muted transition-colors hover:border-border-strong hover:text-ink disabled:opacity-50"
                title={selected.active ? "Run a scrape now" : "Competitor is paused"}
              >
                Run now
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => handle(await syncCompetitor(selected.id)))
                }
                className="rounded-lg border border-border px-3.5 py-2 text-[15px] font-medium text-ink-muted transition-colors hover:border-border-strong hover:text-ink disabled:opacity-50"
              >
                Re-sync schedule
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  startTransition(async () =>
                    handle(await setCompetitorActive(selected.id, !selected.active)),
                  )
                }
                className="rounded-lg border border-border px-3.5 py-2 text-[15px] font-medium text-ink-muted transition-colors hover:border-border-strong hover:text-ink disabled:opacity-50"
              >
                {selected.active ? "Pause monitoring" : "Resume monitoring"}
              </button>
            </div>
          </div>

          {/*
            No delete button, deliberately. Removing a competitor cascades its
            signal_configs — including the Apify schedule ids n8n needs in order
            to cancel the schedules — so a live schedule would keep running and
            keep billing with nothing referencing it. A database trigger blocks
            that delete; pausing is the correct everyday action, and it is the
            only one offered here.
          */}
        </Panel>
      ) : null}
    </div>
  );
}
