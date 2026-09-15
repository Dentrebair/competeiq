import "server-only";

import { createClient } from "@/lib/supabase/server";

/**
 * Whether the free-tier guardrails in lib/tier.ts are active.
 *
 * `pipeline_state.mode` is flipped by hand in the SQL editor (supabase/07),
 * never by app or worker code — see CLAUDE.md, "Open". Defaults to `false`
 * (unrestricted) if the row is somehow missing: the safe failure for a screen
 * under active testing is "not yet throttled", not "silently blocked".
 */
export async function isPipelineLive(): Promise<boolean> {
  const supabase = await createClient();
  const { data } = await supabase.from("pipeline_state").select("mode").limit(1).maybeSingle();
  return data?.mode === "live";
}
