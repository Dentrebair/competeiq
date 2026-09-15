-- ============================================================================
-- REAL-LEAD — run progress tracking + competitor delete
--
-- Run AFTER 10-cutover-remove-apify.sql. Idempotent.
--
-- Two independent additions, both driven by operator feedback after the first
-- live tests:
--
--   1. scrape_runs grows a status so the UI can show what "Run Now" is doing
--      (running -> processing -> succeeded/failed) instead of the operator
--      staring at a spinner with no idea whether it is stuck.
--   2. A hard delete for a competitor needs two FK fixes first. alerts and
--      competitor_products both point at competitors with the Postgres
--      default (NO ACTION), which means today a delete fails outright the
--      moment a competitor has a single alert or baseline row — which is
--      every competitor that has ever run once.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Fix the two FKs that block a hard delete
--
-- alerts.competitor_id -> SET NULL: alerts are deliberately denormalised
-- (competitor_name is copied in) specifically so they survive their
-- competitor being deleted — see CLAUDE.md "Things that surprise people".
-- The FK just never matched that intent until now.
--
-- competitor_products.competitor_id -> CASCADE: this is the Baseline the
-- worker diffs against. Once a competitor is gone there is nothing left to
-- diff, so its baseline rows are dead weight, not history worth keeping
-- (baseline_history already holds the audit trail).
-- ----------------------------------------------------------------------------

alter table public.alerts
  drop constraint if exists alerts_competitor_fk;
alter table public.alerts
  add constraint alerts_competitor_fk foreign key (competitor_id)
    references public.competitors (id) on delete set null;

alter table public.competitor_products
  drop constraint if exists competitor_products_competitor_id_fkey;
alter table public.competitor_products
  add constraint competitor_products_competitor_id_fkey foreign key (competitor_id)
    references public.competitors (id) on delete cascade;


-- ----------------------------------------------------------------------------
-- 2. scrape_runs: status, error, updated_at
--
-- Written by the worker at each stage of one run's life:
--   start_scrape      inserts the row — status defaults to 'running'
--   process_apify_run sets 'processing' on pickup, 'succeeded'/'failed' on exit
--   check_apify_run   sets 'failed' on a terminal Apify status (FAILED/ABORTED)
-- ----------------------------------------------------------------------------

alter table public.scrape_runs
  add column if not exists status     text not null default 'running'
    check (status in ('running', 'processing', 'succeeded', 'failed')),
  add column if not exists error      text,
  add column if not exists updated_at timestamptz not null default now();

grant update (status, error, updated_at) on public.scrape_runs to pipeline_worker;

-- The operator's UI reads this to show live progress on Run Now. Nothing here
-- is sensitive — a run id, which competitor, and a status string.
grant select on public.scrape_runs to authenticated;

drop policy if exists "operator reads scrape runs" on public.scrape_runs;
create policy "operator reads scrape runs" on public.scrape_runs
  for select to authenticated using (true);


-- ----------------------------------------------------------------------------
-- 3. Realtime for scrape_runs, same pattern as alerts/digests (01-app-layer.sql)
-- ----------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public' and tablename = 'scrape_runs'
  ) then
    alter publication supabase_realtime add table public.scrape_runs;
  end if;
end $$;

alter table public.scrape_runs replica identity full;


-- ============================================================================
-- VERIFY — one result set. Every row should say ok = true.
-- ============================================================================

select check_name, ok
from (values
  ('alerts.competitor_id is ON DELETE SET NULL',
     (select confdeltype = 'n' from pg_constraint where conname = 'alerts_competitor_fk')),
  ('competitor_products.competitor_id is ON DELETE CASCADE',
     (select confdeltype = 'c' from pg_constraint
       where conname = 'competitor_products_competitor_id_fkey')),
  ('scrape_runs.status exists',
     exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'scrape_runs'
          and column_name = 'status'
     )),
  ('operator can read scrape_runs',
     has_table_privilege('authenticated', 'public.scrape_runs', 'SELECT')),
  ('scrape_runs is in the realtime publication',
     exists (
       select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public' and tablename = 'scrape_runs'
     ))
) as checks (check_name, ok)
order by ok, check_name;
