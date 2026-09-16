"use client";

import { useMemo, useState } from "react";

import { Panel, PanelHeading } from "@/components/page-header";
import { SIGNAL_TYPES, SIGNAL_TYPE_LABELS, type SignalType } from "@/lib/signals";
import {
  dayKeyRange,
  formatDayKey,
  formatDayRange,
  shiftDayKey,
  splitDayKey,
  utcDayKey,
} from "@/lib/format";
import { normalizeSeverity } from "@/lib/types/database";

/**
 * Signal movement by severity.
 *
 * The strongest widget on this screen, because it is a genuine aggregate of real
 * rows rather than a score somebody invented: for each signal and each day, the
 * most severe thing that happened.
 *
 * Two things it must never do:
 *
 *   1. Show "quiet" where it means "not collected". A pale cell and an empty
 *      cell look alike at a glance, and a monitor that has been dead for two
 *      days would read as a calm week. Signals with no collection configured get
 *      hatched rows saying so, outside the colour ramp entirely.
 *
 *   2. Put an unclassified alert on the ramp. Those failed interpretation and
 *      have no severity; they get their own "review" cell.
 *
 * The window is computed client-side from one payload of recent alerts, so the
 * arrows and the period switch are instant rather than a round trip each.
 */

export interface HistoryPoint {
  signal_type: string;
  severity: string;
  ai_available: boolean;
  created_at: string;
}

type Period = "weekly" | "monthly" | "quarterly";

/** Days shown per period, and how far each arrow moves. */
const PERIOD: Record<Period, { days: number; label: string }> = {
  weekly: { days: 7, label: "Weekly" },
  monthly: { days: 30, label: "Monthly" },
  quarterly: { days: 90, label: "Quarterly" },
};

type CellState = "high" | "medium" | "low" | "review" | "none";

const CELL_STYLE: Record<CellState, { className: string; label: string }> = {
  high: { className: "bg-cell-high text-cell-high-ink", label: "High" },
  medium: { className: "bg-cell-medium text-cell-medium-ink", label: "Medium" },
  low: { className: "bg-cell-low text-cell-low-ink", label: "Low" },
  review: { className: "bg-cell-review text-cell-review-ink", label: "Review" },
  none: { className: "bg-cell-none text-ink-faint", label: "–" },
};

/** Most severe wins the day. Unclassified outranks nothing but is never graded. */
function worst(a: CellState, b: CellState): CellState {
  const order: CellState[] = ["none", "low", "medium", "review", "high"];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

/**
 * What one cell knows.
 *
 * The colour was carrying the severity and nothing was carrying the volume, so
 * a day with one low-severity change looked identical to a day with nine. The
 * count is the thing the operator is actually scanning for — "did something
 * happen here" — and it was the one number the grid did not show.
 */
interface Cell {
  state: CellState;
  count: number;
}

function stateFor(point: HistoryPoint): CellState {
  if (!point.ai_available) return "review";
  const severity = normalizeSeverity(point.severity);
  // critical and high share a cell colour: at this density the distinction is
  // not readable, and both mean "look at this".
  if (severity === "critical" || severity === "high") return "high";
  if (severity === "medium") return "medium";
  return "low";
}

/**
 * Why three states and not two.
 *
 * A signal can be switched on in `signal_configs` while no workflow exists that
 * could ever produce it — WF-02 today only emits price, catalogue and promo
 * changes, so an enabled `website_change` is configuration with nothing behind
 * it. Rendered as a normal row it would be a run of pale cells reading "watched
 * and quiet", which is the exact misreading this grid is supposed to prevent.
 *
 * `signal_configs.last_run_at` would be the obvious way to detect that, and it
 * does not work: WF-02 writes `competitors.last_scanned_at` and never touches
 * `last_run_at`, so every row would look like it had never run. What IS
 * observable is whether the signal has produced an alert in the window — so that
 * is what separates `collected` from `silent`.
 *
 * `silent` deliberately does not claim breakage. Over a long window "monitored
 * and genuinely quiet" and "monitored by nothing" are indistinguishable from the
 * data, and both deserve a look.
 */
export interface SignalCoverage {
  state: "collected" | "silent" | "off" | "coming_soon";
  /** Human cadence, e.g. "Every 3h". Null when nothing is configured. */
  cadence: string | null;
}

export function SignalHistory({
  points,
  coverage,
}: {
  points: HistoryPoint[];
  coverage: Record<SignalType, SignalCoverage>;
}) {
  const [period, setPeriod] = useState<Period>("weekly");
  const [offset, setOffset] = useState(0);

  // The Y axis carries only signals that can actually produce an alert. Four of
  // the seven have no workflow behind them, and four hatched rows in a
  // seven-row grid made the chart mostly disclaimer.
  //
  // They are not simply dropped, though — a named line under the legend keeps
  // the gap in coverage visible. Silently showing three rows would let someone
  // conclude the other four surfaces are quiet rather than unwatched, which is
  // the misreading this whole component is built to prevent.
  const chartedSignals = SIGNAL_TYPES.filter(
    (signal) => coverage[signal].state !== "coming_soon",
  );
  const comingSoon = SIGNAL_TYPES.filter((signal) => coverage[signal].state === "coming_soon");
  const activeCount = chartedSignals.filter(
    (signal) => coverage[signal].state === "collected",
  ).length;

  const { days, grid, rangeLabel, atLatest } = useMemo(() => {
    const { days: length } = PERIOD[period];
    const today = utcDayKey(new Date().toISOString());
    const end = shiftDayKey(today, offset * length);
    const keys = dayKeyRange(end, length);

    const map = new Map<string, Cell>();
    for (const point of points) {
      const key = `${point.signal_type}|${utcDayKey(point.created_at)}`;
      const current = map.get(key);
      map.set(key, {
        state: worst(current?.state ?? "none", stateFor(point)),
        count: (current?.count ?? 0) + 1,
      });
    }

    return {
      days: keys,
      grid: map,
      rangeLabel: formatDayRange(keys[0], keys[keys.length - 1]),
      atLatest: offset === 0,
    };
  }, [period, offset, points]);

  // Long windows cannot show a label per cell, so they shrink to colour only.
  const compact = period !== "weekly";

  return (
    <Panel className="p-6">
      <PanelHeading
        eyebrow="Competitive signal history"
        title="Signal movement by severity"
        description="The most severe change recorded for each signal, day by day."
        aside={
          <span className="tabular text-sm text-ink-faint">
            {activeCount} of {chartedSignals.length} reporting
          </span>
        }
      />

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-border bg-surface-sunken p-1">
          {(Object.keys(PERIOD) as Period[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setPeriod(key);
                setOffset(0);
              }}
              className={`rounded-md px-3 py-1.5 text-base transition-colors ${
                period === key
                  ? "bg-surface font-medium text-ink shadow-[var(--shadow-card)]"
                  : "text-ink-muted hover:text-ink"
              }`}
            >
              {PERIOD[key].label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setOffset((value) => value - 1)}
            aria-label="Earlier period"
            className="rounded-lg border border-border p-1.5 text-ink-muted transition-colors hover:border-border-strong hover:text-ink"
          >
            <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 3.5 5.5 8l4.5 4.5" />
            </svg>
          </button>
          <span className="tabular min-w-[168px] text-center text-base font-medium text-ink">
            {rangeLabel}
          </span>
          <button
            type="button"
            onClick={() => setOffset((value) => Math.min(0, value + 1))}
            disabled={atLatest}
            aria-label="Later period"
            className="rounded-lg border border-border p-1.5 text-ink-muted transition-colors
                       hover:border-border-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 3.5 4.5 4.5L6 12.5" />
            </svg>
          </button>
        </div>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[680px] border-separate border-spacing-[3px]">
          <thead>
            <tr>
              <th className="w-[190px] px-2 pb-2 text-left align-bottom">
                <span className="eyebrow">Signal</span>
              </th>
              {days.map((key) => {
                const { weekday, date } = splitDayKey(key);
                return (
                  <th key={key} className="pb-2 align-bottom">
                    {compact ? (
                      <span className="sr-only">{date}</span>
                    ) : (
                      <span className="flex flex-col items-center leading-tight">
                        <span className="text-xs font-semibold uppercase tracking-wide text-ink">
                          {weekday}
                        </span>
                        <span className="tabular text-xs text-ink-faint">{date}</span>
                      </span>
                    )}
                  </th>
                );
              })}
              <th className="w-[76px] pb-2 pl-3 text-right align-bottom">
                <span className="eyebrow">{compact ? "Avg/day" : "Total"}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {chartedSignals.map((signal) => {
              const { state, cadence } = coverage[signal];

              if (state !== "collected") {
                const detail = state === "off" ? "Not switched on" : `${cadence} · nothing recorded`;
                const explanation =
                  state === "off"
                    ? "Switched off for every competitor."
                    : "Switched on, but no change has ever been recorded. Either genuinely quiet, or nothing is collecting it. Worth checking.";
                return (
                  <tr key={signal}>
                    <td className="hatched rounded-l-md px-2 py-2.5 align-middle">
                      <span className="text-base font-medium text-ink-muted">
                        {SIGNAL_TYPE_LABELS[signal]}
                      </span>
                      <span className="block text-xs text-ink-faint">{detail}</span>
                    </td>
                    {/*
                      One spanning cell rather than a row of empty ones. Empty
                      cells would sit on the same ramp as real quiet days and
                      claim this signal was checked and found calm.
                    */}
                    <td colSpan={days.length + 1} className="hatched rounded-r-md px-3">
                      <span className="text-sm text-ink-faint">{explanation}</span>
                    </td>
                  </tr>
                );
              }

              return (
                <tr key={signal}>
                  <td className="px-2 py-1.5 align-middle">
                    <span className="text-base font-medium text-ink">
                      {SIGNAL_TYPE_LABELS[signal]}
                    </span>
                    {cadence ? (
                      <span className="block text-xs text-ink-faint">{cadence}</span>
                    ) : null}
                  </td>
                  {days.map((key) => {
                    const cell = grid.get(`${signal}|${key}`) ?? { state: "none" as const, count: 0 };
                    const style = CELL_STYLE[cell.state];
                    return (
                      <td key={key} className="p-0">
                        <div
                          title={
                            cell.count === 0
                              ? `${SIGNAL_TYPE_LABELS[signal]} · ${formatDayKey(key)} · nothing recorded`
                              : `${SIGNAL_TYPE_LABELS[signal]} · ${formatDayKey(key)} · ${cell.count} ${
                                  cell.count === 1 ? "change" : "changes"
                                } · most severe: ${style.label}`
                          }
                          className={`tabular grid place-items-center rounded-md text-sm font-semibold ${
                            compact ? "h-6" : "h-11"
                          } ${style.className}`}
                        >
                          {/*
                            The number, not the band. Colour already carries
                            severity and the legend explains it; the count is the
                            fact that was missing. Long windows have no room for
                            a digit, so there the tooltip carries it.
                          */}
                          {compact ? "" : cell.count === 0 ? "–" : cell.count}
                        </div>
                      </td>
                    );
                  })}

                  {/*
                    A week is short enough that a total is the useful figure. A
                    month or a quarter is not — 90 days of totals compare badly
                    against each other, so those show the daily average instead,
                    which is what makes two different-length windows comparable.
                  */}
                  <td className="pl-3 text-right align-middle">
                    {(() => {
                      const total = days.reduce(
                        (sum, key) => sum + (grid.get(`${signal}|${key}`)?.count ?? 0),
                        0,
                      );
                      if (total === 0) {
                        return <span className="text-sm text-ink-faint">–</span>;
                      }
                      return (
                        <span
                          className="tabular text-base font-semibold text-ink"
                          title={
                            compact
                              ? `${total} changes over ${days.length} days`
                              : `${total} changes this week`
                          }
                        >
                          {compact ? (total / days.length).toFixed(1) : total}
                        </span>
                      );
                    })()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-border pt-3 text-sm text-ink-muted">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-3 rounded bg-cell-low" /> Low
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-3 rounded bg-cell-medium" /> Medium
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-3 rounded bg-cell-high" /> High &amp; critical
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-3 rounded bg-cell-review" /> Needs review
        </span>
        {comingSoon.length ? (
          <span className="ml-auto text-ink-faint">
            Not charted yet:{" "}
            {comingSoon.map((signal) => SIGNAL_TYPE_LABELS[signal]).join(", ")}. No collection
            exists for these, so their absence here is not quiet.
          </span>
        ) : null}
      </div>
    </Panel>
  );
}
