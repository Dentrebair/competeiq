-- ============================================================================
-- REAL-LEAD — column ownership + delete safety
--
-- Run AFTER 02-signal-configs.sql. Additive, idempotent.
--
-- Two jobs:
--   1. Stop the app writing columns that n8n owns.
--   2. Stop a competitor delete from orphaning live Apify schedules.
-- ============================================================================

-- ============================================================================
-- 1. Column ownership
--
-- The app declares *desired* state: which competitors, which signals, how often.
-- n8n reconciles that with Apify and writes back *actual* state: the schedule id,
-- the last run, the last error.
--
-- RLS grants access to a row, not to a column, so the policies in 01/02 currently
-- let the app overwrite apify_schedule_id. That matters more than it looks: n8n
-- reads that column to know which Apify schedule to cancel when a signal is
-- disabled. Blank it and the schedule keeps running, keeps scraping, and keeps
-- billing, with nothing left pointing at it.
--
-- Column privileges close that off in the database, so it holds regardless of
-- what any future route handler does.
-- ============================================================================

revoke update on public.signal_configs from authenticated;
grant  update (frequency_hours, enabled) on public.signal_configs to authenticated;

revoke update on public.competitors from authenticated;
grant  update (name, domain, url, active) on public.competitors to authenticated;

-- INSERT is likewise column-scoped: the app supplies identity, never n8n's
-- bookkeeping fields.
revoke insert on public.competitors from authenticated;
grant  insert (id, name, domain, url, active) on public.competitors to authenticated;

revoke insert on public.signal_configs from authenticated;
grant  insert (id, competitor_id, signal_type, frequency_hours, enabled)
  on public.signal_configs to authenticated;

-- ============================================================================
-- 2. Delete safety  ← the hazard
--
-- `signal_configs.competitor_id` is ON DELETE CASCADE. So deleting a competitor
-- destroys its seven signal_configs rows — including every apify_schedule_id —
-- in the same statement.
--
-- If the app deletes the competitor first and then asks n8n to clean up, n8n has
-- nothing left to read. The Apify schedules survive, unreferenced: they keep
-- running on their cron, keep consuming the Apify quota, and keep firing
-- completion webhooks at WF-02 for a competitor that no longer exists. Nothing
-- errors. The bill just does not go down.
--
-- Rather than rely on every future call site remembering the right order, make
-- the wrong order impossible: block the delete while any signal still holds a
-- live Apify schedule.
--
-- Correct teardown becomes:
--   1. App sets competitors.active = false          (stops it appearing in the UI)
--   2. App calls n8n to cancel the Apify schedules
--   3. n8n deletes each schedule, then NULLs apify_schedule_id in Supabase
--   4. Only then does the competitor delete succeed
--
-- Soft-delete via `active = false` is the everyday path; hard delete is rare and
-- now safe.
-- ============================================================================

create or replace function public.block_delete_with_live_schedules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  live_count integer;
begin
  select count(*) into live_count
    from public.signal_configs
   where competitor_id = old.id
     and apify_schedule_id is not null;

  if live_count > 0 then
    raise exception
      'Cannot delete competitor "%" — % Apify schedule(s) still registered. '
      'Cancel them via the n8n Config Loader first; deleting now would leave them '
      'running and billing with nothing referencing them.',
      old.name, live_count
      using errcode = 'foreign_key_violation';
  end if;

  return old;
end;
$$;

drop trigger if exists competitors_block_orphan_schedules on public.competitors;
create trigger competitors_block_orphan_schedules
  before delete on public.competitors
  for each row execute function public.block_delete_with_live_schedules();

-- ============================================================================
-- 3. signal_type constraint — only if the existing data allows it
--
-- One vocabulary across signal_configs and alerts, so alerts.signal_type should
-- be constrained to the same seven strings. But alerts already holds production
-- rows, and a blind ALTER ... ADD CONSTRAINT fails outright if any row disagrees.
--
-- So: check first, add only if clean, and report rather than fail if not.
-- ============================================================================

do $$
declare
  bad_count integer;
  bad_values text;
begin
  select count(*), string_agg(distinct signal_type, ', ')
    into bad_count, bad_values
    from public.alerts
   where signal_type not in (
     'sku_price_change', 'catalog_change', 'promo_discount', 'ad_creative',
     'review_sentiment', 'website_change', 'newsletter');

  if bad_count = 0 then
    if not exists (
      select 1 from pg_constraint where conname = 'alerts_signal_type_check'
    ) then
      alter table public.alerts
        add constraint alerts_signal_type_check
        check (signal_type in (
          'sku_price_change', 'catalog_change', 'promo_discount', 'ad_creative',
          'review_sentiment', 'website_change', 'newsletter'));
      raise notice 'Added alerts_signal_type_check — existing rows all conform.';
    else
      raise notice 'alerts_signal_type_check already present.';
    end if;
  else
    raise notice
      'SKIPPED alerts_signal_type_check: % row(s) use unrecognised signal_type values (%). '
      'Reconcile WF-02 or clean the rows, then re-run this file.',
      bad_count, bad_values;
  end if;
end $$;

-- ============================================================================
-- Verify
-- ============================================================================

-- What `authenticated` may actually write. Expect only the desired-state columns;
-- apify_schedule_id, apify_task_id, last_run_at, last_error must NOT appear.
select table_name, column_name, privilege_type
  from information_schema.column_privileges
 where grantee = 'authenticated'
   and table_schema = 'public'
   and privilege_type in ('INSERT', 'UPDATE')
 order by table_name, privilege_type, column_name;
