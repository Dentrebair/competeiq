-- ============================================================================
-- REAL-LEAD — scrape run tracking
--
-- Run AFTER 07-pipeline-worker.sql. Idempotent.
--
-- The worker enqueues process_apify_run with only a run ID (ADR-0005: "never
-- trusts the webhook body"), so it needs its own record of which competitor
-- that run belongs to. start_scrape writes one row here the moment it starts
-- an Apify run; process_apify_run reads it back by run_id. Self-authored data,
-- not anything read from the webhook payload.
--
-- Not a long-lived table — a row is only needed between "run started" and
-- "run processed". Pruning old rows is a later concern, not required for
-- correctness today.
-- ============================================================================

create table if not exists public.scrape_runs (
  run_id         text not null,
  competitor_id  uuid not null references public.competitors (id) on delete cascade,
  started_at     timestamptz not null default now(),
  constraint scrape_runs_pkey primary key (run_id)
);

create index if not exists scrape_runs_competitor_idx
  on public.scrape_runs (competitor_id);


-- ============================================================================
-- PRIVILEGES
-- ============================================================================

revoke all on public.scrape_runs from anon, authenticated;

-- start_scrape inserts when it starts a run; process_apify_run selects to
-- resolve competitor_id from the bare run_id it was enqueued with.
grant select, insert on public.scrape_runs to pipeline_worker;


-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

alter table public.scrape_runs enable row level security;

drop policy if exists "worker reads scrape runs" on public.scrape_runs;
create policy "worker reads scrape runs" on public.scrape_runs
  for select to pipeline_worker using (true);

drop policy if exists "worker records scrape runs" on public.scrape_runs;
create policy "worker records scrape runs" on public.scrape_runs
  for insert to pipeline_worker with check (true);


-- ============================================================================
-- VERIFY — one result set. Every row should say ok = true.
-- ============================================================================

select check_name, ok
from (values
  ('scrape_runs exists',
     (select count(*) = 1 from information_schema.tables
       where table_schema = 'public' and table_name = 'scrape_runs')),
  ('RLS on for scrape_runs',
     (select relrowsecurity from pg_class where oid = 'public.scrape_runs'::regclass)),
  ('worker can record a run',
     has_table_privilege('pipeline_worker', 'public.scrape_runs', 'INSERT')),
  ('worker can look up a run',
     has_table_privilege('pipeline_worker', 'public.scrape_runs', 'SELECT')),
  ('browser key cannot read scrape runs',
     not has_table_privilege('anon', 'public.scrape_runs', 'SELECT')
     and not has_table_privilege('authenticated', 'public.scrape_runs', 'SELECT'))
) as checks (check_name, ok)
order by ok, check_name;
