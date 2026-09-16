import { IntelligenceView } from "@/components/intelligence/intelligence-view";
import { PageHeader } from "@/components/page-header";
import { LiveDot } from "@/components/ui/chips";
import { requireUser } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import type { Alert, AlertAnalysis, Competitor } from "@/lib/types/database";

/**
 * Filtering happens in the browser over one payload rather than a query per
 * change of filter. At one operator and a few hundred alerts that is a fraction
 * of a megabyte, and it makes the timeline respond instantly — which matters
 * because this screen is used by flicking between changes, not by running one
 * careful search.
 */
const PAGE_SIZE = 300;

export default async function IntelligencePage() {
  await requireUser();
  // Captured once, on the server, and handed down. The "last 7 days" filter needs
  // a reference point, and reading it during a client render makes the filtered
  // list depend on when React happened to re-render.
  // eslint-disable-next-line react-hooks/purity
  const serverNow = Date.now();
  const supabase = await createClient();

  const [alertsResult, competitorsResult] = await Promise.all([
    supabase
      .from("alerts")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE),
    supabase.from("competitors").select("*").order("name"),
  ]);

  const alerts = (alertsResult.data ?? []) as Alert[];

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
        title="Intelligence"
        subtitle="Investigate the evidence behind each competitor move"
        status={<LiveDot state="live" />}
      />

      {alertsResult.error ? (
        <div className="px-8">
          <p
            role="alert"
            className="rounded-xl border border-border bg-sev-critical-wash p-4 text-base text-sev-critical"
          >
            Could not read alerts: {alertsResult.error.message}
          </p>
        </div>
      ) : alerts.length === 0 ? (
        <div className="px-8">
          <p className="rounded-xl border border-dashed border-border-strong p-10 text-base text-ink-muted">
            No changes have been collected yet. Once monitoring runs, every detected move and the
            evidence behind it appears here.
          </p>
        </div>
      ) : (
        <IntelligenceView
          alerts={alerts}
          now={serverNow}
          initialAnalyses={(analysisRows ?? []) as AlertAnalysis[]}
          competitors={((competitorsResult.data ?? []) as Competitor[]).map((c) => c.name)}
        />
      )}
    </main>
  );
}
