-- ============================================================================
-- REAL-LEAD — signal_configs over Realtime
--
-- Run any time after 02-signal-configs.sql. Idempotent.
--
-- The Competitors page's "N signals tracked" count reads from signal_configs,
-- but that table was never added to the supabase_realtime publication (only
-- alerts, digests, and scrape_runs were — see 01 and 11). So the count only
-- ever updated on a full Next.js revalidate/navigation, not live — the same
-- gap scrape_runs had before 11-run-progress-and-delete.sql fixed it for Run
-- Now progress. This closes it the same way, for the same reason: a number
-- that only updates on refresh reads as broken once anything on the page is
-- expected to feel live.
-- ============================================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'signal_configs'
  ) then
    alter publication supabase_realtime add table public.signal_configs;
  end if;
end $$;


-- ============================================================================
-- VERIFY — one result set. Should say ok = true.
-- ============================================================================

select 'signal_configs is in the realtime publication' as check_name,
       exists (
         select 1 from pg_publication_tables
          where pubname = 'supabase_realtime'
            and schemaname = 'public'
            and tablename = 'signal_configs'
       ) as ok;
