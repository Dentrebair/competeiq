"use client";

import { useState, useTransition } from "react";

import { analyzeAlert } from "@/app/actions/analysis";
import { DecisionOptions } from "@/components/decision-options";
import { Panel, PanelHeading } from "@/components/page-header";
import { SeverityChip, SignalTag } from "@/components/ui/chips";
import { EvidenceBody, InsightBlock, WhyItMatters } from "@/components/ui/insight-blocks";
import { alertTitle, severityReason } from "@/lib/alert-title";
import type { Alert, AlertAnalysis } from "@/lib/types/database";

/**
 * The daily briefing: what changed, and the options worth considering.
 *
 * One row per priority alert, each carrying its own set of decisions. The
 * alternatives come from `alert_analyses`, which is generated on request rather
 * than for every alert — so a row without them is the normal state, not an
 * error, and it offers to produce them instead of showing an empty panel.
 *
 * That distinction is deliberate: an empty "decisions to consider" block would
 * claim the model looked and found nothing worth suggesting, which is a very
 * different statement from "nobody has asked yet".
 */

export interface BriefingRow {
  alert: Alert;
  analysis: AlertAnalysis | null;
}

function Avatar({ name }: { name: string }) {
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase() ?? "")
      .join("") || "?";
  return (
    <span
      aria-hidden
      className="grid size-7 shrink-0 place-items-center rounded-full border border-border bg-surface-sunken text-[11px] font-semibold text-ink-muted"
    >
      {initials}
    </span>
  );
}

function Row({ row }: { row: BriefingRow }) {
  const { alert } = row;
  const [analysis, setAnalysis] = useState(row.analysis);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const generate = () =>
    startTransition(async () => {
      setError(null);
      const result = await analyzeAlert(alert.id);
      if (result.ok) setAnalysis(result.analysis);
      else setError(result.error);
    });

  return (
    <div className="border-t border-border px-5 py-4 first:border-t-0">
      {/*
        One column, not three.

        A three-column grid made every row as tall as its tallest cell, so a
        two-line headline sat above a block of dead space the height of the
        evidence beside it. Stacking removes the problem rather than tuning it.
      */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Avatar name={alert.competitor_name} />
        <span className="text-base font-semibold text-ink">{alert.competitor_name}</span>
        <SeverityChip
          severity={alert.severity}
          aiAvailable={alert.ai_available}
          reason={severityReason(alert)}
        />
        <SignalTag type={alert.signal_type} badge className="text-sm" />
      </div>

      <h3 className="mt-2.5 text-lg font-semibold leading-snug text-ink">{alertTitle(alert)}</h3>

      {/*
        Meaning on the left, evidence on the right, with the action that produces
        more meaning sitting under the evidence that justifies it. The button is
        on every row whether or not options exist, so its position never moves.
      */}
      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] lg:items-start">
        {/*
          `pt-4` matches the evidence card's own padding, so the two section
          labels sit on the same line. Without it WHY IT MATTERS floated 16px
          above EVIDENCE and the row read as two unrelated blocks.
        */}
        <WhyItMatters alert={alert} className="border-l-2 border-accent-line pl-3 pt-4" />

        <div className="rounded-xl border border-border bg-surface-sunken p-4">
          <InsightBlock label="Evidence">
            <EvidenceBody alert={alert} />
          </InsightBlock>

          <button
            type="button"
            onClick={generate}
            disabled={pending}
            className="mt-3 w-full rounded-lg bg-solid px-3 py-2 text-base font-medium text-solid-ink
                       transition-colors hover:bg-solid-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending
              ? "Weighing the options…"
              : analysis?.alternatives?.length
                ? "Regenerate options"
                : "Generate options"}
          </button>

          {error ? (
            <p role="alert" className="mt-2 text-sm text-sev-critical">
              {error}
            </p>
          ) : null}
        </div>
      </div>

      {analysis?.alternatives?.length ? (
        <DecisionOptions
          className="mt-4"
          alternatives={analysis.alternatives}
          subject={alert.summary}
          alertId={alert.id}
        />
      ) : null}
    </div>
  );
}

export function DailyBriefing({
  rows,
  generatedAt,
}: {
  rows: BriefingRow[];
  /** When the briefing content was produced, if one exists. */
  generatedAt: string | null;
}) {
  const perspectives = rows.reduce(
    (total, row) => total + (row.analysis?.alternatives?.length ?? 0),
    0,
  );

  return (
    <Panel>
      <div className="px-5 pb-4 pt-5">
        <PanelHeading
          eyebrow={
            generatedAt
              ? `Daily briefing · ${generatedAt.slice(11, 16)} UTC`
              : "Daily briefing"
          }
          title="What changed and the options worth considering"
          aside={
            <span className="tabular text-sm text-ink-faint">
              {rows.length} priority {rows.length === 1 ? "alert" : "alerts"}
              {perspectives > 0 ? ` · ${perspectives} perspectives` : ""}
            </span>
          }
        />
      </div>

      {rows.length === 0 ? (
        <p className="border-t border-border px-5 py-8 text-base text-ink-muted">
          Nothing needs a decision right now. New changes appear here as they are detected.
        </p>
      ) : (
        <div className="border-t border-border">
          {rows.map((row) => (
            <Row key={row.alert.id} row={row} />
          ))}
        </div>
      )}
    </Panel>
  );
}
