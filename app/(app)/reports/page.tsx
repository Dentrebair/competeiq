import { ReportsView } from "@/components/reports/reports-view";
import { PageHeader } from "@/components/page-header";
import { requireUser } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import type { Digest } from "@/lib/types/database";

export default async function ReportsPage() {
  await requireUser();
  const supabase = await createClient();

  // Newest first, and `generated_at` can be null on a run that never finished —
  // so order by created_at, which every row has.
  const { data, error } = await supabase
    .from("digests")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <main className="pb-12">
      <PageHeader
        title="Reports"
        subtitle="Generate evidence-backed competitive briefs"
      />

      {error ? (
        <div className="px-8">
          <p
            role="alert"
            className="rounded-xl border border-border bg-sev-critical-wash p-4 text-base text-sev-critical"
          >
            Could not read briefs: {error.message}
          </p>
        </div>
      ) : (
        <ReportsView initialDigests={(data ?? []) as Digest[]} />
      )}
    </main>
  );
}
