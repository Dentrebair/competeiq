import { Monitoring, type CompetitorRow } from "@/components/competitors/monitoring";
import { PageHeader } from "@/components/page-header";
import { requireUser } from "@/lib/dal";
import { isPipelineLive } from "@/lib/pipeline-mode";
import { SIGNAL_TYPES } from "@/lib/signals";
import { createClient } from "@/lib/supabase/server";
import type { Alert, Competitor, ScrapeRun, SignalConfig } from "@/lib/types/database";

/** Stable display order, matching the Config Loader payload. */
const SIGNAL_ORDER = new Map(SIGNAL_TYPES.map((type, index) => [type, index]));

export default async function CompetitorsPage() {
  await requireUser();
  const supabase = await createClient();

  // Four flat reads rather than PostgREST embeds. `Relationships: []` in the
  // generated types means embedded-resource syntax is not typed here, and at
  // this scale joining in JS costs nothing.
  const [competitorsResult, configsResult, alertsResult, scrapeRunsResult, pipelineLive] = await Promise.all([
    supabase
      .from("competitors")
      .select("*")
      .order("active", { ascending: false })
      .order("name", { ascending: true }),
    supabase.from("signal_configs").select("*"),
    supabase
      .from("alerts")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200),
    // Only the most recent run per competitor matters for "what is Run Now
    // doing" — the client keeps this fresh afterwards over Realtime.
    supabase
      .from("scrape_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(200),
    isPipelineLive(),
  ]);

  const error = competitorsResult.error ?? configsResult.error;

  const configsByCompetitor = new Map<string, SignalConfig[]>();
  for (const config of (configsResult.data ?? []) as SignalConfig[]) {
    const list = configsByCompetitor.get(config.competitor_id) ?? [];
    list.push(config);
    configsByCompetitor.set(config.competitor_id, list);
  }

  // Newest alert per competitor, matched on the denormalised name — alerts
  // deliberately survive their competitor being deleted, so competitor_id can be
  // null on older rows.
  const latestByName = new Map<string, Alert>();
  for (const alert of (alertsResult.data ?? []) as Alert[]) {
    if (!latestByName.has(alert.competitor_name)) latestByName.set(alert.competitor_name, alert);
  }

  // Newest scrape run per competitor — this is "what Run Now is doing right now".
  const latestRunByCompetitor = new Map<string, ScrapeRun>();
  for (const run of (scrapeRunsResult.data ?? []) as ScrapeRun[]) {
    if (!latestRunByCompetitor.has(run.competitor_id)) {
      latestRunByCompetitor.set(run.competitor_id, run);
    }
  }

  const competitors: CompetitorRow[] = ((competitorsResult.data ?? []) as Competitor[]).map(
    (competitor) => ({
      ...competitor,
      configs: (configsByCompetitor.get(competitor.id) ?? []).sort(
        (a, b) =>
          (SIGNAL_ORDER.get(a.signal_type) ?? 99) - (SIGNAL_ORDER.get(b.signal_type) ?? 99),
      ),
      latest: latestByName.get(competitor.name) ?? null,
      latestRun: latestRunByCompetitor.get(competitor.id) ?? null,
    }),
  );

  return (
    <main className="pb-12">
      <PageHeader
        title="Competitors"
        subtitle="Control who is monitored and how often"
      />

      {error ? (
        <div className="px-8">
          <p
            role="alert"
            className="rounded-xl border border-border bg-sev-critical-wash p-4 text-[15px] text-sev-critical"
          >
            Could not load competitors: {error.message}
          </p>
        </div>
      ) : (
        <Monitoring competitors={competitors} pipelineLive={pipelineLive} />
      )}
    </main>
  );
}
