import { Panel, PanelHeading } from "@/components/page-header";
import { TimeAgo } from "@/components/time-ago";
import { SeverityChip, SignalTag, severityRail } from "@/components/ui/chips";
import { alertTitle } from "@/lib/alert-title";
import type { Alert } from "@/lib/types/database";

/**
 * "Who moved today" — the most recent change per competitor.
 *
 * One card each, not a feed. The question this answers is "is anyone doing
 * anything", and a list of thirty rows answers it worse than three cards do.
 *
 * A competitor with no recent change still gets a card. Absence is information:
 * a rival going quiet before a launch window is itself a signal, and dropping
 * them from the row would hide it.
 */
export function WhoMoved({
  latest,
  monitoredCount,
}: {
  latest: {
    competitorName: string;
    alert: Alert | null;
    /** Changes in the window — one card should say how busy a rival has been. */
    changeCount: number;
    /** Most severe of those, so a quiet-but-serious day is not read as quiet. */
    topSeverity: string | null;
  }[];
  monitoredCount: number;
}) {
  return (
    <Panel className="p-5">
      <PanelHeading
        eyebrow="Latest competitor changes"
        title="Who moved today"
        aside={
          <span className="tabular text-[13px] text-ink-faint">
            {monitoredCount} {monitoredCount === 1 ? "competitor" : "competitors"} monitored
          </span>
        }
      />

      {latest.length === 0 ? (
        <p className="mt-5 text-[15px] text-ink-muted">
          No competitors are being monitored yet. Add one to start collecting changes.
        </p>
      ) : (
        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {latest.map(({ competitorName, alert, changeCount, topSeverity }) => (
            <article
              key={competitorName}
              className="relative overflow-hidden rounded-xl border border-border bg-surface-sunken pl-4 pr-4 py-4"
            >
              <span
                aria-hidden
                className={`absolute inset-y-0 left-0 w-1 ${
                  alert ? severityRail(alert.severity, alert.ai_available) : "bg-border-strong"
                }`}
              />

              <div className="flex items-center gap-3">
                <span
                  aria-hidden
                  className="grid size-9 shrink-0 place-items-center rounded-full border border-border bg-surface text-xs font-semibold text-ink-muted"
                >
                  {competitorName
                    .split(/\s+/)
                    .filter(Boolean)
                    .slice(0, 2)
                    .map((word) => word[0]?.toUpperCase() ?? "")
                    .join("") || "?"}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-base font-semibold text-ink">
                    {competitorName}
                  </span>
                  {alert ? (
                    <span className="flex flex-wrap items-center gap-x-2 text-[13px] text-ink-faint">
                      <span className="tabular">
                        {changeCount} {changeCount === 1 ? "change" : "changes"}
                      </span>
                      <span aria-hidden>·</span>
                      <TimeAgo iso={alert.created_at} />
                    </span>
                  ) : (
                    <span className="text-[13px] text-ink-faint">No changes recorded</span>
                  )}
                </span>
              </div>

              {alert ? (
                <div className="mt-3 border-t border-border pt-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {topSeverity ? (
                      <SeverityChip severity={topSeverity} aiAvailable={alert.ai_available} />
                    ) : null}
                    <SignalTag type={alert.signal_type} className="text-xs" />
                  </div>
                  <p className="mt-2 text-base font-semibold leading-snug text-ink">
                    {alertTitle(alert)}
                  </p>
                </div>
              ) : (
                <p className="mt-3 border-t border-border pt-3 text-[15px] text-ink-faint">
                  Quiet since monitoring began. That is worth knowing too.
                </p>
              )}
            </article>
          ))}
        </div>
      )}
    </Panel>
  );
}
