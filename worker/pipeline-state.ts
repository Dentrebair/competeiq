import type { Pool } from "pg";

export type PipelineMode = "live" | "paused";

/**
 * Records that the worker is alive and reads Pipeline Mode, in one statement.
 *
 * The worker can write only `heartbeat_at`. Switching modes is done by hand, in
 * the SQL editor, so a misbehaving worker cannot switch itself back on.
 */
export async function heartbeat(db: Pool): Promise<PipelineMode> {
  const { rows } = await db.query<{ mode: PipelineMode }>(
    "update public.pipeline_state set heartbeat_at = now() returning mode",
  );
  if (rows.length !== 1) {
    throw new Error("public.pipeline_state has no row. Run supabase/07-pipeline-worker.sql.");
  }
  return rows[0].mode;
}
