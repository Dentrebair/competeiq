import { PageHeader } from "@/components/page-header";
import { StoreSetup } from "@/components/store-setup/store-setup";
import { requireUser } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import type { BrandProfile, CompetitorSuggestion } from "@/lib/types/database";

export default async function StoreSetupPage() {
  await requireUser();
  const supabase = await createClient();

  const [{ data: profile }, { data: suggestions }] = await Promise.all([
    supabase.from("brand_profile").select("*").limit(1).maybeSingle(),
    // Only open suggestions. Accepted ones became competitors; dismissed ones
    // stay in the table purely so they are never proposed again.
    supabase
      .from("competitor_suggestions")
      .select("*")
      .eq("status", "suggested")
      .order("created_at", { ascending: false }),
  ]);

  return (
    <main className="pb-12">
      <PageHeader
        title="Store setup"
        subtitle="Tell the product what you sell, so its advice is about your business"
      />
      <StoreSetup
        profile={(profile as BrandProfile | null) ?? null}
        initialSuggestions={(suggestions ?? []) as CompetitorSuggestion[]}
      />
    </main>
  );
}
