"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";

import { markAlertRead, markAlertUnread } from "@/app/actions/alerts";
import { analyzeAlert } from "@/app/actions/analysis";
import { DecisionOptions } from "@/components/decision-options";
import { TimeAgo } from "@/components/time-ago";
import { LiveDot, SeverityChip, SignalTag, severityRail } from "@/components/ui/chips";
import { EvidenceBody, InsightBlock, WhyItMatters } from "@/components/ui/insight-blocks";
import { alertTitle, severityReason } from "@/lib/alert-title";
import { getSignalStatus } from "@/lib/signal-status";
import { signalTypeLabel } from "@/lib/signals";
import { createClient } from "@/lib/supabase/client";
import { normalizeSeverity, type Alert, type AlertAnalysis, type SignalConfig } from "@/lib/types/database";

/**
 * The triage queue.
 *
 * Collapsed rows are for scanning; expanding one is for deciding. That split is
 * the whole design: thirty-nine rows each shouting an instruction is the noise
 * this product exists to remove, so the impact reading and the options stay
 * behind a disclosure.
 *
 * Two tabs, not three. The database has exactly one triage state — `is_read` —
 * so "Needs attention" and "Read" are the only two the data can honestly
 * support. Snoozed and Resolved need columns that do not exist yet; a tab that
 * is always empty because the concept was never built is worse than no tab.
 */

type Connection = "connecting" | "live" | "error";
type Tab = "unread" | "read";

/**
 * Whether a Realtime payload carries enough to render a row.
 *
 * `payload.new` is typed as `T` but is genuinely `T | {}` at runtime — Supabase
 * sends partial records for oversized payloads and rows the subscriber can only
 * partly read. Feeding one straight into state put `undefined` where the
 * renderer expected strings and took down the whole list.
 */
function isRenderableAlert(row: unknown): row is Alert {
  if (!row || typeof row !== "object") return false;
  const candidate = row as Partial<Alert>;
  return (
    typeof candidate.id === "number" &&
    typeof candidate.severity === "string" &&
    typeof candidate.summary === "string" &&
    typeof candidate.created_at === "string"
  );
}

function isHighImpact(alert: Alert): boolean {
  if (!alert.ai_available) return false;
  const severity = normalizeSeverity(alert.severity);
  return severity === "critical" || severity === "high";
}

function ExpandedRow({
  alert,
  analysis,
  onAnalysed,
  onToggleRead,
}: {
  alert: Alert;
  analysis: AlertAnalysis | null;
  onAnalysed: (analysis: AlertAnalysis) => void;
  onToggleRead: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const generate = () =>
    startTransition(async () => {
      setError(null);
      const result = await analyzeAlert(alert.id);
      if (result.ok) onAnalysed(result.analysis);
      else setError(result.error);
    });

  return (
    <div className="border-t border-border bg-surface-sunken px-6 py-5">
      {/* Meaning left, evidence right, matching the Overview so the answer to
          "where is the proof" is in the same place on both screens. */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] lg:items-start">
        {/* Same 16px offset as the evidence card's padding, so the two labels
            line up. See the Overview briefing for the same pairing. */}
        <WhyItMatters alert={alert} className="pt-4" />

        <InsightBlock label="Evidence" className="rounded-xl border border-border bg-surface p-4">
          <EvidenceBody alert={alert} />
        </InsightBlock>
      </div>

      {analysis?.alternatives?.length ? (
        <DecisionOptions
          className="mt-5"
          alternatives={analysis.alternatives}
          subject={alert.summary}
          alertId={alert.id}
        />
      ) : (
        <div className="mt-5 flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-border-strong bg-surface px-4 py-3">
          <p className="text-base text-ink-muted">No suggested decisions yet.</p>
          <button
            type="button"
            onClick={generate}
            disabled={pending}
            className="ml-auto rounded-xl bg-solid px-4 py-2.5 text-base font-semibold text-solid-ink
                       transition-all hover:bg-solid-hover hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? "Weighing the options…" : "Generate options"}
          </button>
          {error ? (
            <p role="alert" className="w-full text-base text-sev-critical">
              {error}
            </p>
          ) : null}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={onToggleRead}
          className="text-base font-medium text-ink-muted underline-offset-4 hover:text-ink hover:underline"
        >
          {alert.is_read ? "Mark unread" : "Mark read"}
        </button>
        {alert.product_url ? (
          <a
            href={alert.product_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-base font-medium text-accent underline-offset-4 hover:underline"
          >
            Open product
          </a>
        ) : null}
      </div>
    </div>
  );
}

export function AlertsTable({
  initialAlerts,
  initialAnalyses,
  initialCompetitor,
  initialSignalType,
}: {
  initialAlerts: Alert[];
  initialAnalyses: AlertAnalysis[];
  /** Deep-linked from a signal chip on the Competitors page — see app/(app)/alerts/page.tsx. */
  initialCompetitor?: string;
  initialSignalType?: string;
}) {
  const [alerts, setAlerts] = useState<Alert[]>(initialAlerts);
  const [analyses, setAnalyses] = useState<Map<number, AlertAnalysis>>(
    () => new Map(initialAnalyses.map((row) => [row.alert_id, row])),
  );
  const [signalConfigs, setSignalConfigs] = useState<SignalConfig[]>([]);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [tab, setTab] = useState<Tab>("unread");
  const [highImpactOnly, setHighImpactOnly] = useState(false);
  const [competitor, setCompetitor] = useState(initialCompetitor ?? "all");
  const [signalType, setSignalType] = useState(initialSignalType ?? "all");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Live payloads we could not render. Surfaced, never silently dropped. */
  const [missedLive, setMissedLive] = useState(0);

  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel("alerts-table")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "alerts" },
        (payload) => {
          if (!isRenderableAlert(payload.new)) {
            setMissedLive((n) => n + 1);
            return;
          }
          const incoming = payload.new;
          setAlerts((prev) =>
            // The server-rendered page and the live stream overlap, so never
            // trust that an insert is new.
            prev.some((a) => a.id === incoming.id) ? prev : [incoming, ...prev],
          );
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "alerts" },
        (payload) => {
          if (!isRenderableAlert(payload.new)) return;
          const updated = payload.new;
          setAlerts((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "signal_configs" },
        (payload) => {
          if (!payload.new || typeof payload.new !== "object") return;
          const updated = payload.new as Partial<SignalConfig>;
          setSignalConfigs((prev) =>
            prev.map((c) =>
              c.id === updated.id ? { ...c, ...updated } : c,
            ),
          );
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") setConnection("live");
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setConnection("error");
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, []);

  const toggleRead = useCallback(async (alert: Alert) => {
    const next = !alert.is_read;

    // Optimistic: the operator should not wait on a round trip to triage.
    setAlerts((prev) =>
      prev.map((a) =>
        a.id === alert.id
          ? { ...a, is_read: next, read_at: next ? new Date().toISOString() : null }
          : a,
      ),
    );
    setError(null);

    const result = next ? await markAlertRead(alert.id) : await markAlertUnread(alert.id);

    if (!result.ok) {
      // Roll back rather than leave the UI asserting something untrue.
      setAlerts((prev) =>
        prev.map((a) =>
          a.id === alert.id ? { ...a, is_read: alert.is_read, read_at: alert.read_at } : a,
        ),
      );
      setError(result.error ?? "Could not update that alert.");
    }
  }, []);

  const competitorNames = useMemo(
    () => [...new Set(alerts.map((a) => a.competitor_name))].sort(),
    [alerts],
  );

  const signalTypesPresent = useMemo(
    () => [...new Set(alerts.map((a) => a.signal_type))].sort(),
    [alerts],
  );

  const counts = useMemo(
    () => ({
      unread: alerts.filter((a) => !a.is_read).length,
      read: alerts.filter((a) => a.is_read).length,
    }),
    [alerts],
  );

  const visible = useMemo(() => {
    let rows = alerts.filter((a) => (tab === "unread" ? !a.is_read : a.is_read));
    if (competitor !== "all") rows = rows.filter((a) => a.competitor_name === competitor);
    if (signalType !== "all") rows = rows.filter((a) => a.signal_type === signalType);
    if (highImpactOnly) rows = rows.filter(isHighImpact);
    return rows;
  }, [alerts, tab, competitor, signalType, highImpactOnly]);

  // Map signal configs by (competitorId, signalType) for quick lookup
  const signalConfigMap = useMemo(() => {
    const map = new Map<string, SignalConfig>();
    for (const config of signalConfigs) {
      map.set(`${config.competitor_id}:${config.signal_type}`, config);
    }
    return map;
  }, [signalConfigs]);

  return (
    <div className="rounded-xl border border-border bg-surface shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-5 py-3">
        <div className="flex items-center gap-1">
          {(
            [
              ["unread", "Needs attention", counts.unread],
              ["read", "Read", counts.read],
            ] as const
          ).map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`relative rounded-lg px-3 py-2 text-base transition-colors ${
                tab === key ? "font-semibold text-ink" : "text-ink-muted hover:text-ink"
              }`}
            >
              {label}
              <span className="tabular ml-2 rounded-full bg-surface-sunken px-1.5 py-0.5 text-sm text-ink-muted">
                {count}
              </span>
              {tab === key ? (
                <span aria-hidden className="absolute inset-x-3 -bottom-[13px] h-0.5 rounded-full bg-accent" />
              ) : null}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-4">
          {/* Only rendered with something to choose between — a single-competitor
              install does not need a dropdown with one entry in it. */}
          {competitorNames.length > 1 ? (
            <label className="relative inline-flex">
              <span className="sr-only">Filter by competitor</span>
              <select
                value={competitor}
                onChange={(event) => setCompetitor(event.target.value)}
                className="appearance-none rounded-lg border border-border bg-surface py-1.5 pl-3 pr-8 text-base
                           text-ink transition-colors hover:border-border-strong focus:border-accent focus:outline-none"
              >
                <option value="all">All competitors</option>
                {competitorNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <svg
                aria-hidden
                viewBox="0 0 16 16"
                className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-faint"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m4 6 4 4 4-4" />
              </svg>
            </label>
          ) : null}

          {signalTypesPresent.length > 1 ? (
            <label className="relative inline-flex">
              <span className="sr-only">Filter by signal</span>
              <select
                value={signalType}
                onChange={(event) => setSignalType(event.target.value)}
                className="appearance-none rounded-lg border border-border bg-surface py-1.5 pl-3 pr-8 text-base
                           text-ink transition-colors hover:border-border-strong focus:border-accent focus:outline-none"
              >
                <option value="all">All signals</option>
                {signalTypesPresent.map((type) => (
                  <option key={type} value={type}>
                    {signalTypeLabel(type)}
                  </option>
                ))}
              </select>
              <svg
                aria-hidden
                viewBox="0 0 16 16"
                className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-faint"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m4 6 4 4 4-4" />
              </svg>
            </label>
          ) : null}

          <label className="flex cursor-pointer items-center gap-2 text-base text-ink-muted">
            High-impact only
            <span className="relative inline-flex">
              <input
                type="checkbox"
                checked={highImpactOnly}
                onChange={(event) => setHighImpactOnly(event.target.checked)}
                className="peer sr-only"
              />
              <span className="block h-5 w-9 rounded-full bg-border-strong transition-colors peer-checked:bg-accent peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-accent" />
              <span className="absolute left-0.5 top-0.5 size-4 rounded-full bg-surface transition-transform peer-checked:translate-x-4" />
            </span>
          </label>
          <LiveDot state={connection} />
        </div>
      </div>

      {error ? (
        <p role="alert" className="border-b border-border px-5 py-3 text-base text-sev-critical">
          {error}
        </p>
      ) : null}

      {missedLive > 0 ? (
        <p role="status" className="border-b border-border px-5 py-3 text-base text-sev-high">
          {missedLive} live {missedLive === 1 ? "update" : "updates"} arrived incomplete and could
          not be shown.{" "}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="underline underline-offset-2"
          >
            Reload
          </button>{" "}
          to see them — they are saved in the database.
        </p>
      ) : null}

      <div className="hidden grid-cols-[132px_minmax(0,1fr)_150px_110px_36px] gap-4 border-b border-border px-5 py-2.5 md:grid">
        <span className="eyebrow">Severity</span>
        <span className="eyebrow">Change</span>
        <span className="eyebrow">Signal</span>
        <span className="eyebrow">Signal Status</span>
        <span />
      </div>

      {visible.length === 0 ? (
        <p className="px-5 py-10 text-base text-ink-muted">
          {competitor !== "all" || signalType !== "all"
            ? `Nothing here for ${[
                competitor !== "all" ? competitor : null,
                signalType !== "all" ? signalTypeLabel(signalType) : null,
              ]
                .filter(Boolean)
                .join(" · ")} in ${tab === "unread" ? "Needs attention" : "Read"}. Try the other tab, or clear a filter above.`
            : tab === "unread"
              ? highImpactOnly
                ? "Nothing high-impact is waiting. Untick the filter to see everything."
                : "Nothing needs attention. That is a good day, not an error."
              : "Nothing has been marked read yet."}
        </p>
      ) : (
        <ul>
          {visible.map((alert) => {
            const isOpen = expanded === alert.id;

            return (
              <li key={alert.id} className="relative border-b border-border last:border-b-0">
                <span
                  aria-hidden
                  className={`absolute inset-y-0 left-0 w-1 ${severityRail(
                    alert.severity,
                    alert.ai_available,
                  )} ${alert.ai_available ? "" : "opacity-70"}`}
                />

                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : alert.id)}
                  aria-expanded={isOpen}
                  className={`grid w-full grid-cols-1 items-center gap-2 px-5 py-4 pl-6 text-left transition-colors
                              hover:bg-surface-sunken md:grid-cols-[132px_minmax(0,1fr)_150px_110px_36px] md:gap-4 ${
                                alert.is_read ? "opacity-70" : ""
                              }`}
                >
                  <SeverityChip
                    severity={alert.severity}
                    aiAvailable={alert.ai_available}
                    reason={severityReason(alert)}
                  />

                  {/*
                    Closed rows carry four things only: headline, severity,
                    signal, time. The evidence and the decisions live in the open
                    state — a queue where every row shouts its full reasoning is
                    the noise this product exists to remove.
                  */}
                  <span className="min-w-0">
                    <span className="block truncate text-base font-semibold text-ink">
                      {alertTitle(alert)}
                    </span>
                    <span className="block truncate text-sm text-ink-faint">
                      {alert.competitor_name}
                    </span>
                  </span>

                  <SignalTag type={alert.signal_type} badge className="text-sm" />

                  {(() => {
                    const config = signalConfigMap.get(
                      `${alert.competitor_id}:${alert.signal_type}`,
                    );
                    const { message, color } = getSignalStatus(
                      config?.last_change_at ?? null,
                      config?.change_count_30d ?? 0,
                      alert.created_at,
                    );

                    const colorClass = {
                      red: "text-sev-high font-medium",
                      yellow: "text-yellow-600 font-medium",
                      green: "text-sev-low",
                      gray: "text-ink-faint",
                    }[color];

                    return (
                      <span
                        className={`text-sm ${colorClass}`}
                        title={message}
                      >
                        {message}
                      </span>
                    );
                  })()}

                  <span
                    aria-hidden
                    className={`hidden justify-self-end text-ink-faint transition-transform md:block ${
                      isOpen ? "rotate-180" : ""
                    }`}
                  >
                    <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m4 6 4 4 4-4" />
                    </svg>
                  </span>
                </button>

                {isOpen ? (
                  <ExpandedRow
                    alert={alert}
                    analysis={analyses.get(alert.id) ?? null}
                    onAnalysed={(analysis) =>
                      setAnalyses((prev) => new Map(prev).set(analysis.alert_id, analysis))
                    }
                    onToggleRead={() => void toggleRead(alert)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
