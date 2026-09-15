import { PageHeader, Panel, PanelHeading } from "@/components/page-header";
import { requireUser } from "@/lib/dal";
import { SIGNAL_TYPES, SIGNAL_TYPE_LABELS, isSignalLive } from "@/lib/signals";
import {
  FREE_TIER_CADENCE_HOURS,
  FREE_TIER_MAX_COMPETITORS,
  FREE_TIER_MAX_PRODUCTS_PER_COMPETITOR,
  FREE_TIER_RUN_NOW_COOLDOWN_HOURS,
} from "@/lib/tier";

/**
 * Informational only — there is no billing or checkout anywhere in this app.
 * The Free column states what `lib/tier.ts` actually enforces once
 * `pipeline_state.mode` is `live` (see lib/pipeline-mode.ts); the Paid column
 * is what upgrading the Apify plan would remove, for the operator's own
 * planning, not a purchasable product.
 */

const liveSignals = SIGNAL_TYPES.filter(isSignalLive).map((type) => SIGNAL_TYPE_LABELS[type]);

const ROWS: { feature: string; free: string; paid: string }[] = [
  {
    feature: "Competitors monitored",
    free: `Up to ${FREE_TIER_MAX_COMPETITORS}`,
    paid: "No fixed limit",
  },
  {
    feature: "Products tracked per competitor",
    free: `Up to ${FREE_TIER_MAX_PRODUCTS_PER_COMPETITOR}`,
    paid: "Full catalog",
  },
  {
    feature: "Signals available",
    free: liveSignals.join(", "),
    paid: `${liveSignals.join(", ")} — the rest ship as they're built, for every tier`,
  },
  {
    feature: "Automated check frequency",
    free: `Weekly (every ${FREE_TIER_CADENCE_HOURS}h)`,
    paid: "As often as each signal is configured for",
  },
  {
    feature: `"Run Now" (manual)`,
    free: `Once every ${FREE_TIER_RUN_NOW_COOLDOWN_HOURS}h per competitor`,
    paid: "Unrestricted",
  },
];

export default async function PricingPage() {
  await requireUser();

  return (
    <main className="pb-12">
      <PageHeader
        title="Pricing"
        subtitle="What the free tier protects against, and what upgrading would remove"
      />
      <div className="flex flex-col gap-4 px-8">
        <Panel className="p-5">
          <PanelHeading
            eyebrow="Informational only"
            title="Free tier vs. paid tier"
            description="There is nothing to buy here yet — this exists so the limits you're testing against have a reason attached. The free-tier figures are enforced in code the moment monitoring goes live; the paid column is what upgrading the underlying Apify plan would unlock."
          />

          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-left text-[15px]">
              <thead>
                <tr className="border-b border-border text-ink-muted">
                  <th className="py-2 pr-4 font-medium">Feature</th>
                  <th className="py-2 pr-4 font-medium">Free tier (now)</th>
                  <th className="py-2 font-medium">Paid tier (informational)</th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row) => (
                  <tr key={row.feature} className="border-b border-border last:border-0">
                    <td className="py-3 pr-4 font-medium text-ink">{row.feature}</td>
                    <td className="py-3 pr-4 text-ink-muted">{row.free}</td>
                    <td className="py-3 text-ink-faint">{row.paid}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </main>
  );
}
