import Link from "next/link";

import { AlertsTable } from "@/components/alerts/alerts-table";
import { PageHeader, Panel } from "@/components/page-header";
import { requireUser } from "@/lib/dal";
import { SIGNAL_TYPES } from "@/lib/signals";
import { createClient } from "@/lib/supabase/server";
import type { Alert, AlertAnalysis, Competitor, SignalConfig } from "@/lib/types/database";

/** First page. Realtime prepends anything newer as it arrives. */
const PAGE_SIZE = 100;

/**
 * Pipeline health, not delivery health.
 *
 * The mockup put a "Delivery healthy · Email and WhatsApp connected" bar here.
 * Nothing in this system records what was sent, to whom, or when — and WhatsApp
 * is not part of the product at all. What the system genuinely knows is whether
 * its *collection* is working, which is more useful on this screen anyway: a
 * monitor that has quietly stopped is the failure mode that makes an empty
 * triage queue a lie.
 */
function CollectionHealth({
  configs,
  competitors,
}: {
  configs: SignalConfig[];
  competitors: Competitor[];
}) {
  const active = configs.filter((config) => config.enabled);
  const failing = active.filter((config) => Boolean(config.last_error));
  const unavailable = competitors.length * SIGNAL_TYPES.length - active.length;

  const lastRun = active
    .map((config) => config.last_run_at)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);

  const healthy = failing.length === 0;

  return (
    <Panel className="flex flex-wrap items-center gap-x-8 gap-y-4 px-5 py-4">
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden
          className={`grid size-10 shrink-0 place-items-center rounded-full ${
            healthy ? "bg-sev-low-wash text-sev-low" : "bg-sev-high-wash text-sev-high"
          }`}
        >
          <svg viewBox="0 0 18 18" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="9" cy="9" r="6.5" />
            <circle cx="9" cy="9" r="2.4" />
          </svg>
        </span>
        <div className="min-w-0">
          <p className="eyebrow">Collection health</p>
          <p className="mt-0.5 text-base font-semibold text-ink">
            {healthy
              ? `${active.length} monitored signal ${active.length === 1 ? "schedule is" : "schedules are"} healthy`
              : `${failing.length} of ${active.length} signal schedules are failing`}
          </p>
          <p className="mt-0.5 text-[13px] text-ink-faint">
            {active.length} active {active.length === 1 ? "signal" : "signals"} across{" "}
            {competitors.length} {competitors.length === 1 ? "competitor" : "competitors"}
            {lastRun ? ` · last collection ${new Date(lastRun).toISOString().slice(11, 16)} UTC` : " · no collection recorded yet"}
          </p>
        </div>
      </div>

      <dl className="flex items-center gap-8">
        {[
          ["Competitors", competitors.length],
          ["Failing", failing.length],
          ["Not collected", Math.max(0, unavailable)],
        ].map(([label, value]) => (
          <div key={label as string}>
            <dt className="eyebrow">{label}</dt>
            <dd className="tabular mt-1 text-xl font-semibold text-ink">{value}</dd>
          </div>
        ))}
      </dl>

      <Link
        href="/competitors"
        className="ml-auto rounded-lg border border-border px-3.5 py-2 text-[15px] font-medium text-ink-muted
                   transition-colors hover:border-border-strong hover:text-ink"
      >
        Manage signals
      </Link>
    </Panel>
  );
}

export default async function AlertsPage() {
  await requireUser();
  const supabase = await createClient();

  const [alertsResult, configsResult, competitorsResult] = await Promise.all([
    supabase
      .from("alerts")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE),
    supabase.from("signal_configs").select("*"),
    supabase.from("competitors").select("*").eq("active", true),
  ]);

  const alerts = (alertsResult.data ?? []) as Alert[];

  // Pre-load the analyses that exist, so an already-analysed alert expands with
  // its options rather than offering to generate them again.
  const { data: analysisRows } = alerts.length
    ? await supabase
        .from("alert_analyses")
        .select("*")
        .in(
          "alert_id",
          alerts.map((alert) => alert.id),
        )
    : { data: [] };

  return (
    <main className="pb-12">
      <PageHeader
        title="Alerts"
        subtitle="Scan quickly, expand each move to compare decision perspectives"
      />

      <div className="flex flex-col gap-4 px-8">
        <CollectionHealth
          configs={(configsResult.data ?? []) as SignalConfig[]}
          competitors={(competitorsResult.data ?? []) as Competitor[]}
        />

        {alertsResult.error ? (
          <p
            role="alert"
            className="rounded-xl border border-border bg-sev-critical-wash p-4 text-[15px] text-sev-critical"
          >
            Could not read alerts: {alertsResult.error.message}
          </p>
        ) : (
          <AlertsTable
            initialAlerts={alerts}
            initialAnalyses={(analysisRows ?? []) as AlertAnalysis[]}
          />
        )}
      </div>
    </main>
  );
}
