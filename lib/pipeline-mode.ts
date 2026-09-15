import "server-only";

import { createClient } from "@/lib/supabase/server";

/** However wrong this one read goes, it must never be allowed to take longer than this. */
const TIMEOUT_MS = 3000;

/**
 * Whether the free-tier guardrails in lib/tier.ts are active.
 *
 * `pipeline_state.mode` is flipped by hand in the SQL editor (supabase/07),
 * never by app or worker code — see CLAUDE.md, "Open". Defaults to `false`
 * (unrestricted) on every failure mode — a missing row, a rejected query, or
 * one that never resolves at all — because the safe failure for a screen
 * under active testing is "not yet throttled", never "silently blocked".
 *
 * The timeout race is load-bearing, not defensive dressing: this is called
 * inside the Competitors page's own `Promise.all` alongside the competitor
 * data itself, so a slow or stuck read on this one flag was able to take the
 * entire page down with it — a purely cosmetic check (it only greys out a
 * cadence dropdown) should never have that much blast radius.
 */
export async function isPipelineLive(): Promise<boolean> {
  const read = (async () => {
    const supabase = await createClient();
    const { data } = await supabase.from("pipeline_state").select("mode").limit(1).maybeSingle();
    return data?.mode === "live";
  })().catch(() => false);

  const timeout = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(false), TIMEOUT_MS);
  });

  return Promise.race([read, timeout]);
}
