-- ============================================================================
-- REAL-LEAD — cutover: remove Apify Tasks/Schedules leftovers
--
-- Run AFTER 09-worker-reads-brand-profile.sql. Idempotent.
--
-- ADR-0004/0005: the worker owns the scrape clock now (pg-boss schedules,
-- supabase/08-scrape-runs.sql), and n8n is fully replaced in code (Processing,
-- Scheduling and Digest are all in worker/ and app/actions/ — see
-- docs/app-intelligence-migration-spec.md). This migration is gated on having
-- confirmed the Apify console shows no live schedules or tasks — run it only
-- after that check, per ADR-0005: "Apify leftovers are removed after cutover."
--
-- Unlike every prior migration in this set, this one is destructive: it drops
-- a trigger, a function, and two columns. Safe specifically because nothing
-- writes or reads them anymore — grep the app and worker for
-- apify_task_id / apify_schedule_id before running this on a fork that has
-- diverged from what shipped alongside it.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The delete-order trigger (03-ownership-hardening.sql § 2)
--
-- Existed to stop a competitor delete from orphaning a live Apify schedule.
-- Apify schedules no longer exist in this design, so the hazard it guarded
-- against is gone. It is NOT replaced by an equivalent guard for the pg-boss
-- schedule in supabase/08-scrape-runs.sql — there is no delete-competitor UI
-- yet (components/competitors/monitoring.tsx: "No delete button,
-- deliberately"). If one is added later, clear the pg-boss schedule
-- (lib/queue/intake.ts's clearSchedule) before deleting, the same way pausing
-- already does via syncCompetitorSchedule in app/actions/competitors.ts.
-- ----------------------------------------------------------------------------

drop trigger if exists competitors_block_orphan_schedules on public.competitors;
drop function if exists public.block_delete_with_live_schedules();

-- ----------------------------------------------------------------------------
-- 2. The columns themselves
-- ----------------------------------------------------------------------------

alter table public.signal_configs drop column if exists apify_schedule_id;
alter table public.competitors    drop column if exists apify_task_id;


-- ============================================================================
-- VERIFY — one result set. Every row should say ok = true.
-- ============================================================================

select check_name, ok
from (values
  ('apify_task_id column is gone',
     not exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'competitors'
          and column_name = 'apify_task_id'
     )),
  ('apify_schedule_id column is gone',
     not exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'signal_configs'
          and column_name = 'apify_schedule_id'
     )),
  ('delete-order trigger is gone',
     not exists (
       select 1 from pg_trigger where tgname = 'competitors_block_orphan_schedules'
     )),
  ('block_delete_with_live_schedules function is gone',
     not exists (
       select 1 from pg_proc where proname = 'block_delete_with_live_schedules'
     ))
) as checks (check_name, ok)
order by ok, check_name;
