-- ============================================================================
-- REAL-LEAD — URGENT: scrape_runs missing UPDATE policy for pipeline_worker
--
-- Run immediately.
--
-- 11-run-progress-and-delete.sql granted pipeline_worker column-level UPDATE
-- on (status, error, updated_at) but never added an RLS policy permitting
-- pipeline_worker to update any row at all. With RLS enabled and no
-- qualifying policy, every UPDATE from that role has been silently
-- affecting zero rows ever since — no error, no exception, just a no-op.
--
-- Consequence, confirmed live: updateScrapeRunStatus has never actually
-- persisted a single status change since migration 11 shipped. Every run
-- has stayed at "running" in the database regardless of what actually
-- happened, which is what the sweep (worker/handlers/sweep-stale-runs.ts)
-- has been (correctly, given what it could see) treating as stuck —
-- resolving it by re-enqueuing process_apify_run, which runs Claude and
-- Apify again, writes the same alert again (harmless — the diff finds
-- nothing new against the already-updated baseline), and then fails to
-- persist "succeeded" for the exact same RLS reason, so the sweep finds it
-- stale again ~60 seconds later. Forever, until this is applied.
-- ============================================================================

drop policy if exists "worker updates scrape runs" on public.scrape_runs;
create policy "worker updates scrape runs" on public.scrape_runs
  for update to pipeline_worker using (true) with check (true);


-- ============================================================================
-- VERIFY — one result set. Should say ok = true.
-- ============================================================================

select 'pipeline_worker can update scrape_runs' as check_name,
       exists (
         select 1 from pg_policies
          where schemaname = 'public'
            and tablename = 'scrape_runs'
            and policyname = 'worker updates scrape runs'
       ) as ok;
