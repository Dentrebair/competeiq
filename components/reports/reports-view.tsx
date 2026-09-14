"use client";

import { useEffect, useState, useTransition } from "react";

import { requestDigest } from "@/app/actions/digest";
import { Panel, PanelHeading } from "@/components/page-header";
import { TimeAgo } from "@/components/time-ago";
import { useChat } from "@/components/chat-provider";
import { DIGEST_STALE_AFTER_HOURS, digestTimestamp } from "@/lib/digest";
import { createClient } from "@/lib/supabase/client";
import type { Digest } from "@/lib/types/database";

/**
 * Reports, built on `digests`.
 *
 * The mockup showed a scheduling card, PDF/email delivery and weekly/monthly/
 * custom period pickers. None of that exists: there is no reports table, no
 * scheduler and no mail path from the app. What *does* exist is the briefing —
 * a generated document with a headline, a priority action and the alerts it was
 * built from, which is the same artefact under a different name.
 *
 * So this screen is the briefing archive. Everything on it is real:
 *
 *   - Generating calls the same workflow the dashboard does.
 *   - Each past briefing opens with the evidence it cited.
 *   - "Save as PDF" is the browser's own print dialogue, which genuinely
 *     produces a PDF rather than promising a file nothing can create.
 *
 * The scheduling and email pieces are deliberately absent rather than drawn and
 * inert. A schedule control that changes nothing is worse than none.
 */

function isRenderableDigest(row: unknown): row is Digest {
  if (!row || typeof row !== "object") return false;
  const candidate = row as Partial<Digest>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.status === "string" &&
    typeof candidate.created_at === "string"
  );
}

const STATUS_STYLE: Record<Digest["status"], { label: string; className: string }> = {
  ready: { label: "Ready", className: "text-sev-low" },
  generating: { label: "Generating", className: "text-sev-high" },
  failed: { label: "Failed", className: "text-sev-critical" },
};

function ReportModal({ digest, onClose }: { digest: Digest; onClose: () => void }) {
  const { openChat } = useChat();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const period =
    digest.period_start && digest.period_end
      ? `${digest.period_start.slice(0, 10)} – ${digest.period_end.slice(0, 10)}`
      : digestTimestamp(digest).slice(0, 10);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-ink/30"
      />
      <div className="relative flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-[var(--shadow-raised)]">
        <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
          <div>
            <p className="eyebrow">Competitive brief</p>
            <h2 className="tabular mt-1 text-xl font-semibold tracking-tight text-ink">{period}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-surface-sunken hover:text-ink"
          >
            <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="m4 4 8 8M12 4l-8 8" />
            </svg>
            <span className="sr-only">Close</span>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-3 divide-x divide-border rounded-xl border border-border">
            {[
              ["alerts summarised", digest.alert_count ?? digest.alert_ids?.length ?? 0],
              ["patterns found", digest.patterns?.length ?? 0],
              ["priority action", digest.priority_action ? 1 : 0],
            ].map(([label, value]) => (
              <div key={label as string} className="px-4 py-3">
                <p className="tabular text-2xl font-semibold text-ink">{value}</p>
                <p className="mt-0.5 text-[13px] text-ink-muted">{label}</p>
              </div>
            ))}
          </div>

          {digest.headline ? (
            <section className="mt-6">
              <p className="eyebrow">Executive summary</p>
              <p className="mt-2 text-base leading-relaxed text-ink">{digest.headline}</p>
            </section>
          ) : null}

          {digest.priority_action ? (
            <section className="mt-6 border-t border-border pt-5">
              <p className="eyebrow">Priority action</p>
              <h3 className="mt-2 text-[17px] font-semibold text-ink">
                {digest.priority_action.action}
              </h3>
              <p className="mt-1.5 text-[15px] leading-relaxed text-ink-muted">
                <span className="font-medium text-ink">Why now: </span>
                {digest.priority_action.why_now}
              </p>
              <button
                type="button"
                onClick={() =>
                  openChat({
                    digestId: digest.id,
                    anchor: "priority_action",
                    subject: digest.headline ?? "This briefing",
                    suggestions: [
                      "Walk me through whether this is the right priority.",
                      "What would I be giving up by doing this?",
                    ],
                  })
                }
                className="mt-3 text-[15px] font-medium text-accent underline-offset-4 hover:underline print:hidden"
              >
                Discuss this brief
              </button>
            </section>
          ) : null}

          {digest.patterns?.length ? (
            <section className="mt-6 border-t border-border pt-5">
              <p className="eyebrow">Patterns</p>
              <ul className="mt-2 flex flex-col gap-3">
                {digest.patterns.map((pattern, index) => (
                  <li key={index} className="border-l-2 border-border pl-3">
                    <p className="text-[15px] leading-relaxed text-ink">{pattern.pattern}</p>
                    {pattern.competitors_involved?.length ? (
                      <p className="mt-0.5 text-[13px] text-ink-faint">
                        {pattern.competitors_involved.join(" · ")}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {digest.alert_ids?.length ? (
            <section className="mt-6 border-t border-border pt-5">
              <p className="eyebrow">Evidence reviewed</p>
              <p className="tabular mt-2 text-[15px] text-ink-muted">
                {digest.alert_ids.length} alerts: {digest.alert_ids.map((id) => `#${id}`).join(", ")}
              </p>
            </section>
          ) : null}

          {digest.status === "failed" && digest.error ? (
            <p className="mt-6 rounded-lg bg-sev-critical-wash px-3 py-2 font-mono text-[13px] text-sev-critical">
              {digest.error}
            </p>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border px-6 py-4 print:hidden">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-[15px] font-medium text-ink-muted transition-colors hover:border-border-strong hover:text-ink"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded-lg bg-solid px-4 py-2 text-[15px] font-medium text-solid-ink transition-colors hover:bg-solid-hover"
          >
            Print / save PDF
          </button>
        </footer>
      </div>
    </div>
  );
}

export function ReportsView({ initialDigests }: { initialDigests: Digest[] }) {
  const [digests, setDigests] = useState(initialDigests);
  const [open, setOpen] = useState<Digest | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // A briefing is written by n8n minutes after it is requested, from outside
  // this session. Realtime is the only way the row's arrival reaches the page.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("digests-reports")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "digests" },
        (payload) => {
          if (!isRenderableDigest(payload.new)) return;
          const incoming = payload.new;
          setDigests((prev) => {
            const index = prev.findIndex((row) => row.id === incoming.id);
            if (index === -1) return [incoming, ...prev];
            const next = [...prev];
            next[index] = incoming;
            return next;
          });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, []);

  const generating = digests.some((digest) => digest.status === "generating");

  const generate = () =>
    startTransition(async () => {
      setNotice(null);
      const result = await requestDigest(true);
      if (result.error) setNotice(result.error);
      if (result.digest) {
        setDigests((prev) =>
          prev.some((row) => row.id === result.digest!.id) ? prev : [result.digest!, ...prev],
        );
      }
    });

  return (
    <div className="flex flex-col gap-4 px-8">
      <Panel className="p-5">
        <PanelHeading
          eyebrow="Create report"
          title="Generate a competitive brief"
          description={`Claude reads the alerts in the period and writes one decision brief. Briefings older than ${DIGEST_STALE_AFTER_HOURS} hours regenerate automatically when you open the dashboard.`}
        />

        {/*
          Three cards, one of them live.
          
          The workflow that writes these takes every UNREAD alert — it has no
          period parameter at all. So "weekly" and "custom" are not variants of
          the button beside them; they are a change to WF-03. Drawing all three
          as equal choices would be three controls where one works, so the two
          that do not are marked and disabled rather than dressed up.
        */}
        <div className="mt-5 grid gap-3 md:grid-cols-3">
          {[
            {
              title: "Current brief",
              detail: "Every unread alert, written up as one decision brief.",
              live: true,
            },
            {
              title: "Weekly brief",
              detail: "A fixed seven-day window. Needs a date range on the briefing workflow.",
              live: false,
            },
            {
              title: "Custom range",
              detail: "Any period up to 90 days. Same workflow change as weekly.",
              live: false,
            },
          ].map((card) => (
            <div
              key={card.title}
              className={`flex flex-col rounded-xl border p-4 ${
                card.live
                  ? "border-accent-line bg-accent-wash/50"
                  : "hatched border-border"
              }`}
            >
              <p className="text-base font-semibold text-ink">{card.title}</p>
              <p className="mt-1 flex-1 text-[15px] leading-relaxed text-ink-muted">
                {card.detail}
              </p>
              {card.live ? (
                <button
                  type="button"
                  onClick={generate}
                  disabled={pending || generating}
                  className="mt-3 rounded-lg bg-solid px-4 py-2 text-[15px] font-medium text-solid-ink
                             transition-colors hover:bg-solid-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {generating ? "Writing…" : pending ? "Requesting…" : "Generate"}
                </button>
              ) : (
                <span className="mt-3 inline-flex w-fit rounded bg-surface-sunken px-2 py-1 text-xs font-semibold uppercase tracking-wider text-ink-faint">
                  Coming soon
                </span>
              )}
            </div>
          ))}
        </div>

        {notice ? (
          <p role="status" className="mt-4 rounded-lg bg-sev-high-wash px-3 py-2 text-[15px] text-sev-high">
            {notice}
          </p>
        ) : null}

        {generating ? (
          <p className="mt-4 rounded-lg border border-dashed border-border-strong px-4 py-3 text-[15px] text-ink-muted">
            A brief is being written now. It takes a few minutes and appears below on its own — no
            need to wait on this page.
          </p>
        ) : null}
      </Panel>

      <Panel>
        <div className="px-5 pb-4 pt-5">
          <PanelHeading eyebrow="History" title="Recent briefs" />
        </div>

        {digests.length === 0 ? (
          <p className="border-t border-border px-5 py-10 text-[15px] text-ink-muted">
            No briefs yet. Generate one above, or open the dashboard — a briefing is produced
            automatically when the last one is stale.
          </p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-t border-border">
                <th className="eyebrow px-5 py-2.5 text-left">Brief</th>
                <th className="eyebrow px-5 py-2.5 text-left">Period</th>
                <th className="eyebrow px-5 py-2.5 text-left">Status</th>
                <th className="eyebrow px-5 py-2.5 text-left">Alerts</th>
                <th className="eyebrow px-5 py-2.5 text-left">Generated</th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {digests.map((digest) => {
                const status = STATUS_STYLE[digest.status];
                return (
                  <tr key={digest.id} className="border-t border-border">
                    <td className="px-5 py-3.5">
                      <p className="text-[15px] font-medium text-ink">
                        {digest.headline ?? "Competitive brief"}
                      </p>
                      <TimeAgo
                        iso={digestTimestamp(digest)}
                        className="text-[13px] text-ink-faint"
                      />
                    </td>
                    <td className="tabular px-5 py-3.5 text-[15px] text-ink-muted">
                      {digest.period_start && digest.period_end
                        ? `${digest.period_start.slice(0, 10)} – ${digest.period_end.slice(0, 10)}`
                        : "–"}
                    </td>
                    <td className={`px-5 py-3.5 text-[15px] font-medium ${status.className}`}>
                      {status.label}
                    </td>
                    <td className="tabular px-5 py-3.5 text-[15px] text-ink-muted">
                      {digest.alert_count ?? digest.alert_ids?.length ?? 0}
                    </td>
                    <td className="tabular px-5 py-3.5 text-[13px] text-ink-faint">
                      {digestTimestamp(digest).slice(0, 16).replace("T", " ")} UTC
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <button
                        type="button"
                        onClick={() => setOpen(digest)}
                        disabled={digest.status === "generating"}
                        className="text-[15px] font-medium text-accent underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:text-ink-faint disabled:no-underline"
                      >
                        View
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      {open ? <ReportModal digest={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
