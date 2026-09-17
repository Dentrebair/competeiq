-- ============================================================================
-- REAL-LEAD — scrape_runs.apify_status
--
-- Run any time after 17-scrape-runs-observability.sql. Idempotent.
--
-- `scrape_runs.status` is OUR pipeline stage (running/processing/succeeded/
-- failed) — it always was, and stays that way for the backstop/sweep
-- threshold logic that depends on it. This is a second, narrower column:
-- Apify's own literal terminal word, so the UI can show "Timed out" or
-- "Aborted" instead of a single generic "Error" for every kind of failure.
--
-- Six values, not just Apify's four terminal ones. Verified against Apify's
-- current docs (docs.apify.com/api/v2/actor-run-get) — the terminal values
-- use a HYPHEN, not an underscore ("TIMED-OUT", never "TIMED_OUT"):
--   SUCCEEDED, FAILED, TIMED-OUT, ABORTED  — verbatim from Apify's own API
--   UNREACHABLE  — ours: the stale-run sweep couldn't reach Apify at all,
--                  after 3 attempts (worker/handlers/sweep-stale-runs.ts)
--   HUNG         — ours: Apify still said RUNNING (or something
--                  unexpected) long past any real run's duration
--
-- NULL means the pipeline's own processing failed (empty dataset, Claude
-- errors) — Apify itself succeeded, so this column correctly has nothing
-- to say; the fault is ours, not Apify's, and `error` explains it instead.
-- ============================================================================

alter table public.scrape_runs
  add column if not exists apify_status text
    check (apify_status is null or apify_status in
      ('SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED', 'UNREACHABLE', 'HUNG'));

grant update (apify_status) on public.scrape_runs to pipeline_worker;


-- ============================================================================
-- VERIFY — one result set. Should say ok = true.
-- ============================================================================

select 'scrape_runs.apify_status exists' as check_name,
       exists (
         select 1 from information_schema.columns
          where table_schema = 'public'
            and table_name = 'scrape_runs'
            and column_name = 'apify_status'
       ) as ok;
