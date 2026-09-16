import { readLatestDigest } from "@/app/actions/digest";
import { PageHeader } from "@/components/page-header";
import { DailyBriefing, type BriefingRow } from "@/components/overview/briefing";
import {
  SignalHistory,
  type HistoryPoint,
  type SignalCoverage,
} from "@/components/overview/signal-history";
import { WhoMoved } from "@/components/overview/who-moved";
import { LiveDot } from "@/components/ui/chips";
import { requireUser } from "@/lib/dal";
import { SIGNAL_TYPES, isSignalLive, type SignalType } from "@/lib/signals";
import { createClient } from "@/lib/supabase/server";
import {
  normalizeSeverity,
  SEVERITY_ORDER,
  type Alert,
  type AlertAnalysis,
  type Competitor,
  type SignalConfig,
} from "@/lib/types/database";

/** How far back the heatmap can look. One operator, so this stays small. */
const HISTORY_DAYS = 120;
/** Rows in the briefing. More than a handful and it stops being a briefing. */
const PRIORITY_ROWS = 5;

function cadenceLabel(hours: number): string {
  if (hours === 24) return "Daily";
  if (hours === 168) return "Weekly";
  if (hours % 24 === 0) return `Every ${hours / 24}d`;
  return `Every ${hours}h`;
}

/** Most urgent first, then most recent. Unclassified sorts with medium. */
function priorityRank(alert: Alert): number {
  return SEVERITY_ORDER.indexOf(normalizeSeverity(alert.severity));
}

export default async function OverviewPage() {
  // The authorization boundary. The layout calls this too; both are deliberate,
  // because a page can render without its layout on some navigations.
  await requireUser();
  const supabase = await createClient();

  // Server Components render once per request, so reading the clock here is the
  // intended behaviour rather than the instability the purity rule guards
  // against — there is no re-render for it to produce a different answer in.
  // eslint-disable-next-line react-hooks/purity
  const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString();

  const [alertsResult, competitorsResult, configsResult, digest] = await Promise.all([
    supabase
      .from("alerts")
      .select("*")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(2000),
    supabase.from("competitors").select("*").eq("active", true).order("name"),
    supabase.from("signal_configs").select("*"),
    readLatestDigest(),
  ]);

  if (alertsResult.error) {
    return (
      <main className="px-8 pb-12">
        <PageHeader title="Overview" subtitle="What changed, what matters, and what to consider next" />
        <p
          role="alert"
          className="rounded-xl border border-border bg-sev-critical-wash p-4 text-base text-sev-critical"
        >
          Could not read alerts: {alertsResult.error.message}
          <span className="mt-1 block text-ink-muted">
            Run the migrations in supabase/, then confirm the alerts SELECT policy exists and RLS
            is enabled.
          </span>
        </p>
      </main>
    );
  }

  const alerts = (alertsResult.data ?? []) as Alert[];
  const competitors = (competitorsResult.data ?? []) as Competitor[];
  const configs = (configsResult.data ?? []) as SignalConfig[];

  // --- Who moved: the newest change per competitor -------------------------
  // Built from the competitor list rather than from the alerts, so a rival with
  // nothing recent still appears. Going quiet is information.
  const newestByCompetitor = new Map<string, Alert>();
  const countByCompetitor = new Map<string, number>();
  const worstByCompetitor = new Map<string, string>();

  for (const alert of alerts) {
    if (!newestByCompetitor.has(alert.competitor_name)) {
      newestByCompetitor.set(alert.competitor_name, alert);
    }
    countByCompetitor.set(
      alert.competitor_name,
      (countByCompetitor.get(alert.competitor_name) ?? 0) + 1,
    );
    // "Latest" and "most serious" are rarely the same alert, and a card showing
    // only the latest can read as calm on a day something critical landed.
    if (alert.ai_available) {
      const current = worstByCompetitor.get(alert.competitor_name);
      const rank = priorityRank(alert);
      if (current === undefined || rank < SEVERITY_ORDER.indexOf(normalizeSeverity(current))) {
        worstByCompetitor.set(alert.competitor_name, alert.severity);
      }
    }
  }

  const names = competitors.length
    ? competitors.map((competitor) => competitor.name)
    : [...newestByCompetitor.keys()];

  const latest = names.slice(0, 6).map((competitorName) => ({
    competitorName,
    alert: newestByCompetitor.get(competitorName) ?? null,
    changeCount: countByCompetitor.get(competitorName) ?? 0,
    topSeverity: worstByCompetitor.get(competitorName) ?? null,
  }));

  // --- Briefing: the few changes actually worth a decision -----------------
  //
  // Every monitored competitor gets a row before any competitor gets a second.
  //
  // Sorting purely by severity meant one busy rival could take all three slots
  // and the briefing would say nothing at all about the others, which reads as
  // "they were quiet" rather than "they were crowded out".
  const unread = [...alerts]
    .filter((alert) => !alert.is_read)
    .sort((a, b) => {
      const rank = priorityRank(a) - priorityRank(b);
      if (rank !== 0) return rank;
      return b.created_at.localeCompare(a.created_at);
    });

  const claimed = new Set<string>();
  const priorityAlerts: Alert[] = [];
  for (const alert of unread) {
    if (claimed.has(alert.competitor_name)) continue;
    claimed.add(alert.competitor_name);
    priorityAlerts.push(alert);
  }
  // Then fill any remaining slots with the next most urgent, whoever they are.
  for (const alert of unread) {
    if (priorityAlerts.length >= PRIORITY_ROWS) break;
    if (!priorityAlerts.includes(alert)) priorityAlerts.push(alert);
  }
  priorityAlerts.splice(PRIORITY_ROWS);

  // One query for the analyses rather than one per row.
  const analysesById = new Map<number, AlertAnalysis>();
  if (priorityAlerts.length) {
    const { data } = await supabase
      .from("alert_analyses")
      .select("*")
      .in(
        "alert_id",
        priorityAlerts.map((alert) => alert.id),
      );
    for (const row of (data ?? []) as AlertAnalysis[]) analysesById.set(row.alert_id, row);
  }

  const briefingRows: BriefingRow[] = priorityAlerts.map((alert) => ({
    alert,
    analysis: analysesById.get(alert.id) ?? null,
  }));

  // --- Signal history ------------------------------------------------------
  //
  // Three states, because two would lie. `signal_configs` records what the
  // operator *asked* to monitor, which is not the same as what any workflow can
  // actually deliver: WF-02 today emits only price, catalogue and promo changes,
  // so a switched-on `website_change` is a setting with nothing behind it.
  //
  // The obvious detector — `signal_configs.last_run_at` — is unusable, because
  // WF-02 writes `competitors.last_scanned_at` and never touches it. So the test
  // is whether the signal has actually produced an alert in the window.
  const fastestHours = new Map<SignalType, number>();
  for (const config of configs) {
    if (!config.enabled) continue;
    // Competitors can disagree on cadence. Show the fastest, since that governs
    // how quickly anything reaches this grid at all.
    const current = fastestHours.get(config.signal_type);
    if (current === undefined || config.frequency_hours < current) {
      fastestHours.set(config.signal_type, config.frequency_hours);
    }
  }

  const producedSignals = new Set(alerts.map((alert) => alert.signal_type));

  const coverage = Object.fromEntries(
    SIGNAL_TYPES.map((signal) => {
      // Availability outranks configuration: a signal nothing can produce is
      // "coming soon" however the toggles are set.
      if (!isSignalLive(signal)) {
        return [signal, { state: "coming_soon" as const, cadence: null }];
      }
      const hours = fastestHours.get(signal);
      if (hours === undefined) {
        return [signal, { state: "off" as const, cadence: null }];
      }
      return [
        signal,
        {
          state: producedSignals.has(signal) ? ("collected" as const) : ("silent" as const),
          cadence: cadenceLabel(hours),
        },
      ];
    }),
  ) as Record<SignalType, SignalCoverage>;

  const historyPoints: HistoryPoint[] = alerts.map((alert) => ({
    signal_type: alert.signal_type,
    severity: alert.severity,
    ai_available: alert.ai_available,
    created_at: alert.created_at,
  }));

  return (
    <main className="pb-12">
      <PageHeader
        title="Overview"
        subtitle="What changed, what matters, and what to consider next"
        status={<LiveDot state="live" />}
      />

      <div className="flex flex-col gap-4 px-8">
        <WhoMoved latest={latest} monitoredCount={competitors.length} />

        <DailyBriefing
          rows={briefingRows}
          generatedAt={digest?.generated_at ?? digest?.created_at ?? null}
        />

        <SignalHistory points={historyPoints} coverage={coverage} />
      </div>
    </main>
  );
}
