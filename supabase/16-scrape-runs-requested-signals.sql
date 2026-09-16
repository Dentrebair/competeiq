-- ============================================================================
-- REAL-LEAD — scrape_runs.requested_signals
--
-- Run any time after 11-run-progress-and-delete.sql. Idempotent.
--
-- "Run Now" gained a signal picker: the operator can ask for only some
-- signals to be evaluated on a given run rather than always all four. That
-- choice has to survive from the click until process_apify_run runs —
-- which can be minutes later, triggered by Apify's own webhook, on a
-- payload that carries only the run ID (ADR-0005: never trust the webhook
-- body). So the choice is persisted here, on the same row start_scrape
-- already writes, and process_apify_run reads it back the same way it
-- already reads which competitor the run belongs to.
--
-- NULL means "no restriction" — every signal is evaluated, exactly today's
-- behavior. This is the value for every existing row, every scheduled cron
-- run, and the "Run in 2 min" preview (which deliberately has no picker).
-- ============================================================================

alter table public.scrape_runs
  add column if not exists requested_signals text[];


-- ============================================================================
-- VERIFY — one result set. Should say ok = true.
-- ============================================================================

select 'scrape_runs.requested_signals exists' as check_name,
       exists (
         select 1 from information_schema.columns
          where table_schema = 'public'
            and table_name = 'scrape_runs'
            and column_name = 'requested_signals'
       ) as ok;
