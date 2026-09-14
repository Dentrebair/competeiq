"use server";

import { requireUser } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/**
 * Mark one alert read.
 *
 * Runs under the operator's own session, so RLS applies and the column grants
 * from 01-app-layer.sql mean this can only touch `is_read` and `read_at`. An
 * attempt to widen this to `severity` or `summary` would be rejected by the
 * database, not merely by convention.
 */
export async function markAlertRead(alertId: number): Promise<ActionResult> {
  await requireUser();

  const supabase = await createClient();
  const { error } = await supabase
    .from("alerts")
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq("id", alertId);

  if (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/** Undo, for a misclick. Clears the timestamp too so it is not misleading. */
export async function markAlertUnread(alertId: number): Promise<ActionResult> {
  await requireUser();

  const supabase = await createClient();
  const { error } = await supabase
    .from("alerts")
    .update({ is_read: false, read_at: null })
    .eq("id", alertId);

  if (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * Mark every currently-unread alert read.
 *
 * Scoped with `.eq("is_read", false)` rather than updating everything, so it
 * writes only the rows that actually change — and cannot silently rewrite
 * `read_at` on alerts the operator dealt with days ago.
 */
export async function markAllAlertsRead(): Promise<ActionResult> {
  await requireUser();

  const supabase = await createClient();
  const { error } = await supabase
    .from("alerts")
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq("is_read", false);

  if (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true };
}
