-- ============================================================================
-- REAL-LEAD — scrape_runs observability columns
--
-- Run any time after 11-run-progress-and-delete.sql. Idempotent.
--
-- Three columns identified in docs/scaling-gap-analysis.md as missing for
-- explaining a run after the fact, without any change to who owns writes
-- (the worker still owns all three, same grant as status/error/updated_at).
--
--   dataset_id    — which Apify dataset produced the alerts from this run,
--                   so a later question ("what did this run actually see?")
--                   doesn't require Apify to still have the run around.
--   completed_at  — a clean "when did this finish" timestamp, distinct from
--                   updated_at (which also moves on the intermediate
--                   running -> processing step).
--   retry_count   — how many times pg-boss retried the start_scrape job
--                   before this run was recorded. pg-boss already tracks
--                   this internally (Job.retryCount); it was simply never
--                   read or persisted before.
-- ============================================================================

alter table public.scrape_runs
  add column if not exists dataset_id   text,
  add column if not exists completed_at timestamptz,
  add column if not exists retry_count  int not null default 0;

grant update (dataset_id, completed_at, retry_count) on public.scrape_runs to pipeline_worker;


-- ============================================================================
-- VERIFY — one result set. Every row should say ok = true.
-- ============================================================================

select check_name, ok
from (values
  ('scrape_runs.dataset_id exists',
     (select true from information_schema.columns
       where table_schema = 'public' and table_name = 'scrape_runs' and column_name = 'dataset_id')),
  ('scrape_runs.completed_at exists',
     (select true from information_schema.columns
       where table_schema = 'public' and table_name = 'scrape_runs' and column_name = 'completed_at')),
  ('scrape_runs.retry_count exists',
     (select true from information_schema.columns
       where table_schema = 'public' and table_name = 'scrape_runs' and column_name = 'retry_count'))
) as checks (check_name, ok)
order by check_name;
