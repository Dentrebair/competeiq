"use client";

import { useMemo, useState, useTransition } from "react";

import { analyzeAlert } from "@/app/actions/analysis";
import { useChat } from "@/components/chat-provider";
import { DecisionOptions } from "@/components/decision-options";
import { TimeAgo } from "@/components/time-ago";
import { SeverityChip, SignalMark, SignalTag } from "@/components/ui/chips";
import { EvidenceBody, InsightBlock, RiskLine, SentenceList } from "@/components/ui/insight-blocks";
import { alertMovement, alertTitle, severityReason } from "@/lib/alert-title";
import { formatDayKey, utcDayKey } from "@/lib/format";
import { SIGNAL_TYPES, SIGNAL_TYPE_LABELS, signalTypeLabel } from "@/lib/signals";
import {
  normalizeConfidence,
  normalizeSeverity,
  type Alert,
  type AlertAnalysis,
} from "@/lib/types/database";

/**
 * Investigate one competitor move.
 *
 * Three panes: what happened (timeline), the evidence, and what it might mean.
 * The order is the argument — a recommendation the operator cannot check gets
 * ignored, so the evidence sits between the list and the interpretation rather
 * than behind a tab.
 *
 * The centre pane leads with the *text* comparison. Screenshots would be the
 * obvious hero, but nothing in this system stores an image, and most of the
 * seven signal types never will — a pane built around a picture would be empty
 * far more often than not.
 */

type Range = "24h" | "7d" | "30d" | "all";

const RANGE_MS: Record<Range, number | null> = {
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  all: null,
};

const RANGE_LABEL: Record<Range, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  all: "All time",
};

function Select({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  label: string;
}) {
  return (
    <label className="relative inline-flex">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="appearance-none rounded-lg border border-border bg-surface py-2 pl-3 pr-8 text-base text-ink
                   transition-colors hover:border-border-strong focus:border-accent focus:outline-none"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
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
  );
}

function Evidence({ alert }: { alert: Alert }) {

  return (
    <div className="flex flex-col self-start rounded-xl border border-border bg-surface shadow-[var(--shadow-card)]">
      <header className="flex items-start gap-3 border-b border-border px-5 py-4">
        <SignalMark type={alert.signal_type} />
        <div className="min-w-0">
          <p className="eyebrow">{alert.competitor_name} · Evidence</p>
          <h2 className="mt-1 text-2xl font-semibold leading-tight tracking-tight text-ink">
            {alertTitle(alert)}
          </h2>
          <div className="mt-2.5 flex flex-wrap items-center gap-2 text-sm text-ink-faint">
            <SeverityChip
              severity={alert.severity}
              aiAvailable={alert.ai_available}
              reason={severityReason(alert)}
            />
            <SignalTag type={alert.signal_type} badge className="text-sm" />
            <span>
              Detected <TimeAgo iso={alert.created_at} />
            </span>
          </div>
        </div>
      </header>

      <div className="space-y-4 px-5 py-4">
        <InsightBlock label="What changed">
          <SentenceList text={alert.summary} />
        </InsightBlock>

        <InsightBlock label="Evidence">
          <div className="rounded-lg border border-border bg-surface-sunken px-4 py-3">
            <EvidenceBody alert={alert} size="lg" />
          </div>
        </InsightBlock>

        {/*
          Provenance the system can actually vouch for. The mockup had a
          "Source verified" tick, which would imply a check nobody performs;
          naming the workflow and run is true and just as reassuring.
        */}
        <p className="tabular flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border pt-3 text-sm text-ink-faint">
          <svg aria-hidden viewBox="0 0 16 16" className="size-3.5 shrink-0 text-sev-low" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="m3 8.5 3.2 3L13 5" />
          </svg>
          <span className="font-medium text-ink-muted">{alert.workflow}</span>
          captured this
          {alert.execution_id ? ` · run ${alert.execution_id}` : ""}
          {` · ${alert.created_at.slice(0, 16).replace("T", " ")} UTC`}
        </p>
      </div>
    </div>
  );
}

function Interpretation({
  alert,
  analysis,
  onAnalysed,
}: {
  alert: Alert;
  analysis: AlertAnalysis | null;
  onAnalysed: (analysis: AlertAnalysis) => void;
}) {
  const { openChat } = useChat();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const confidence = normalizeConfidence(alert.confidence);

  const generate = () =>
    startTransition(async () => {
      setError(null);
      const result = await analyzeAlert(alert.id);
      if (result.ok) onAnalysed(result.analysis);
      else setError(result.error);
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-border bg-surface p-5 shadow-[var(--shadow-card)]">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="eyebrow">Business insight</p>
            <h3 className="mt-1 text-xl font-semibold tracking-tight text-ink">
              What this could mean
            </h3>
          </div>
          {/* Rendered only when a confidence was actually recorded. Absence is
              not "medium confidence" — it is no assessment at all. */}
          {confidence ? (
            <span className="rounded-full border border-border px-2.5 py-0.5 text-sm capitalize text-ink-muted">
              {confidence} confidence
            </span>
          ) : null}
        </div>

        <p className="mt-2 text-sm italic leading-relaxed text-ink-faint">
          Written by AI from the collected signals — read it as a starting point, not a finding.
          The evidence beside it is what was actually observed.
        </p>

        <InsightBlock label="Business risk" className="mt-4 border-t border-border pt-4">
          <RiskLine alert={alert} reason={severityReason(alert)} />
        </InsightBlock>

        <div className="mt-4 border-t border-border pt-4">
          <div className="flex items-center justify-between gap-2">
            <p className="eyebrow">Likely meaning</p>
            <button
              type="button"
              onClick={() =>
                openChat({
                  alertId: alert.id,
                  anchor: "impact",
                  subject: alert.summary,
                  suggestions: [
                    "How does this affect my margins?",
                    "Which of my products does this hit hardest?",
                    "Is this worth responding to at all?",
                  ],
                })
              }
              className="inline-flex items-center gap-1.5 text-base font-medium text-accent underline-offset-4 hover:underline"
            >
              <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 9.4a2 2 0 0 1-2 2H6l-3.2 2.4V4.6a2 2 0 0 1 2-2h7.2a2 2 0 0 1 2 2Z" />
              </svg>
              Discuss
            </button>
          </div>

          {alert.impact ? (
            <SentenceList text={alert.impact} className="mt-2" />
          ) : !alert.ai_available ? (
            <p className="mt-2 text-base leading-relaxed text-ink-faint">
              Automated interpretation failed for this signal, so it has no severity, confidence or
              impact reading. The evidence beside this is unaffected.
            </p>
          ) : (
            /*
              No impact line, but there is usually still a recommendation. Saying
              "nothing was recorded" directly above one reads as the panel
              contradicting itself, so lead with what we do have and describe the
              gap as a depth limit rather than an absence.
            */
            <p className="mt-2 text-base leading-relaxed text-ink-muted">
              This change was classified and summarised, but not yet read against your own
              catalogue. Go deeper below to do that.
            </p>
          )}

          {alert.recommended_action ? (
            <InsightBlock label="Suggested response" className="mt-4 border-t border-border pt-4">
              <p className="text-base leading-relaxed text-ink">{alert.recommended_action}</p>
            </InsightBlock>
          ) : null}

          {/*
            Questions to discuss. Not model output — these are composed from the
            fields on the row, so they are always answerable from evidence that
            is already on screen. Presenting them as AI-generated insight would
            claim a judgement nothing made.
          */}
          <InsightBlock label="Questions to discuss" className="mt-4 border-t border-border pt-4">
            <div className="flex flex-col gap-1.5">
              {[
                `How does this affect my margin on comparable products?`,
                alert.product_title
                  ? `Do I sell anything comparable to ${alert.product_title}?`
                  : `Which of my products does this overlap?`,
                `Is this worth responding to at all?`,
              ].map((question) => (
                <button
                  key={question}
                  type="button"
                  onClick={() =>
                    openChat({
                      alertId: alert.id,
                      anchor: "question",
                      subject: alert.summary,
                      suggestions: [question],
                    })
                  }
                  className="rounded-lg border border-dashed border-border-strong px-3 py-2 text-left text-base
                             text-ink-muted transition-colors hover:border-accent hover:bg-accent-wash hover:text-ink"
                >
                  {question}
                </button>
              ))}
            </div>
          </InsightBlock>
        </div>
      </div>

      {analysis?.deeper_impact ? (
        <div className="rounded-xl border border-border bg-surface p-5 shadow-[var(--shadow-card)]">
          <p className="eyebrow">Deeper reading</p>
          <p className="mt-2 text-base leading-relaxed text-ink">{analysis.deeper_impact}</p>
        </div>
      ) : null}

      {analysis?.alternatives?.length ? (
        <DecisionOptions
          alternatives={analysis.alternatives}
          subject={alert.summary}
          alertId={alert.id}
          columns={1}
        />
      ) : (
        <div className="rounded-xl border border-dashed border-border-strong bg-surface p-5">
          <p className="eyebrow">Need another perspective?</p>
          <p className="mt-2 text-base text-ink-muted">
            Generate alternative approaches and compare what each one costs you.
          </p>
          <button
            type="button"
            onClick={generate}
            disabled={pending}
            className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-solid px-4 py-2.5
                       text-base font-medium text-solid-ink transition-colors hover:bg-solid-hover
                       disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? "Weighing the options…" : "Go deeper"}
            <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 2.2 9.3 5.4 12.5 6.7 9.3 8 8 11.2 6.7 8 3.5 6.7 6.7 5.4 8 2.2Z" />
            </svg>
          </button>
          {error ? (
            <p role="alert" className="mt-2 text-base text-sev-critical">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function IntelligenceView({
  alerts,
  now,
  initialAnalyses,
  competitors,
}: {
  alerts: Alert[];
  /** Request time from the server. See the page for why it is not read here. */
  now: number;
  initialAnalyses: AlertAnalysis[];
  competitors: string[];
}) {
  const [analyses, setAnalyses] = useState(
    () => new Map(initialAnalyses.map((row) => [row.alert_id, row])),
  );
  const [query, setQuery] = useState("");
  const [competitor, setCompetitor] = useState("all");
  const [signal, setSignal] = useState("all");
  const [severity, setSeverity] = useState("all");
  const [range, setRange] = useState<Range>("7d");
  const [selectedId, setSelectedId] = useState<number | null>(alerts[0]?.id ?? null);

  const filtered = useMemo(() => {
    const window = RANGE_MS[range];
    const cutoff = window ? now - window : null;
    const needle = query.trim().toLowerCase();

    return alerts.filter((alert) => {
      if (cutoff && new Date(alert.created_at).getTime() < cutoff) return false;
      if (competitor !== "all" && alert.competitor_name !== competitor) return false;
      if (signal !== "all" && alert.signal_type !== signal) return false;
      if (severity !== "all") {
        if (severity === "unclassified") {
          if (alert.ai_available) return false;
        } else if (!alert.ai_available || normalizeSeverity(alert.severity) !== severity) {
          return false;
        }
      }
      if (needle) {
        const haystack = `${alert.summary} ${alert.competitor_name} ${alert.product_title ?? ""}`;
        if (!haystack.toLowerCase().includes(needle)) return false;
      }
      return true;
    });
  }, [alerts, now, query, competitor, signal, severity, range]);

  // Grouped by UTC day. Same reasoning as everywhere else in this app: a local
  // key would place a late-evening alert in a different group on the server than
  // in the browser and the two renders would disagree about structure.
  const groups = useMemo(() => {
    const out: { key: string; alerts: Alert[] }[] = [];
    for (const alert of filtered) {
      const key = utcDayKey(alert.created_at);
      const last = out[out.length - 1];
      if (last && last.key === key) last.alerts.push(alert);
      else out.push({ key, alerts: [alert] });
    }
    return out;
  }, [filtered]);

  const selected = filtered.find((alert) => alert.id === selectedId) ?? filtered[0] ?? null;

  return (
    <div className="flex flex-col gap-4 px-8">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[240px] flex-1">
          <span className="sr-only">Search competitor or change</span>
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-faint"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <circle cx="7.2" cy="7.2" r="4.4" />
            <path d="m10.6 10.6 3 3" />
          </svg>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search competitor or change"
            className="w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-3 text-base text-ink
                       placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
        </label>

        <Select
          label="Competitor"
          value={competitor}
          onChange={setCompetitor}
          options={[
            { value: "all", label: "All competitors" },
            ...competitors.map((name) => ({ value: name, label: name })),
          ]}
        />
        <Select
          label="Signal"
          value={signal}
          onChange={setSignal}
          options={[
            { value: "all", label: "Tracked signals" },
            ...SIGNAL_TYPES.map((type) => ({ value: type, label: SIGNAL_TYPE_LABELS[type] })),
          ]}
        />
        <Select
          label="Severity"
          value={severity}
          onChange={setSeverity}
          options={[
            { value: "all", label: "All severity" },
            { value: "critical", label: "Critical" },
            { value: "high", label: "High" },
            { value: "medium", label: "Medium" },
            { value: "low", label: "Low" },
            { value: "unclassified", label: "Unclassified" },
          ]}
        />
        <Select
          label="Time range"
          value={range}
          onChange={(value) => setRange(value as Range)}
          options={(Object.keys(RANGE_LABEL) as Range[]).map((key) => ({
            value: key,
            label: RANGE_LABEL[key],
          }))}
        />
      </div>

      {/*
        The evidence column used to take the largest share and spent most of it
        on empty space — a price comparison is four numbers, and it was sized for
        a screenshot pair that does not exist. The interpretation is the longest
        prose on the screen, so the ratio is inverted: evidence sized to its
        content, insight given the room.
      */}
      <div className="grid items-start gap-4 lg:grid-cols-[280px_minmax(0,1fr)_minmax(0,1.15fr)] xl:grid-cols-[300px_minmax(0,1fr)_minmax(0,1.3fr)]">
        <div className="rounded-xl border border-border bg-surface shadow-[var(--shadow-card)]">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <p className="eyebrow">Signal timeline</p>
            <span className="tabular text-sm text-ink-faint">
              {filtered.length} {filtered.length === 1 ? "change" : "changes"}
            </span>
          </div>

          {groups.length === 0 ? (
            <p className="px-4 py-8 text-base text-ink-muted">
              Nothing matches these filters. Widen the range or clear the search.
            </p>
          ) : (
            <div className="max-h-[70vh] overflow-y-auto">
              {groups.map((group) => (
                <div key={group.key}>
                  <p className="sticky top-0 z-10 bg-surface/95 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-ink-muted backdrop-blur-sm">
                    {formatDayKey(group.key)}
                  </p>
                  {group.alerts.map((alert) => {
                    const active = selected?.id === alert.id;
                    return (
                      <button
                        key={alert.id}
                        type="button"
                        onClick={() => setSelectedId(alert.id)}
                        className={`relative block w-full border-b border-border px-4 py-3 text-left transition-colors ${
                          active ? "bg-accent-wash/60" : "hover:bg-surface-sunken"
                        }`}
                      >
                        {active ? (
                          <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-accent" />
                        ) : null}
                        {/*
                          Headline only. A four-line paragraph per row turns the
                          timeline into a wall of prose you have to read rather
                          than scan; the full sentence is one click away in the
                          evidence pane.
                        */}
                        <p className="text-base font-semibold leading-snug text-ink">
                          {alertTitle(alert)}
                        </p>
                        <div className="mt-1.5 flex items-center justify-between gap-2">
                          <SeverityChip
                            severity={alert.severity}
                            aiAvailable={alert.ai_available}
                            reason={severityReason(alert)}
                          />
                          <TimeAgo iso={alert.created_at} className="text-xs text-ink-faint" />
                        </div>
                        <p className="mt-1 truncate text-sm text-ink-faint">
                          {alert.competitor_name} · {signalTypeLabel(alert.signal_type)}
                          {alertMovement(alert) ? ` · ${alertMovement(alert)}` : ""}
                        </p>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>

        {selected ? (
          <>
            <Evidence alert={selected} />
            <Interpretation
              alert={selected}
              analysis={analyses.get(selected.id) ?? null}
              onAnalysed={(analysis) =>
                setAnalyses((prev) => new Map(prev).set(analysis.alert_id, analysis))
              }
            />
          </>
        ) : (
          <div className="rounded-xl border border-dashed border-border-strong p-10 lg:col-span-2">
            <p className="text-base text-ink-muted">
              Select a change on the left to see its evidence and what it might mean.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
