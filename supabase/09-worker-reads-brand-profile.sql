-- ============================================================================
-- REAL-LEAD — worker reads the brand profile
--
-- Run AFTER 08-scrape-runs.sql. Idempotent.
--
-- generate_digest (replacing WF-03) builds the same <brand_profile> block WF-03
-- did, so it needs to read public.brand_profile. 07-pipeline-worker.sql never
-- granted pipeline_worker anything on this table — it didn't exist as a worker
-- concern until the digest job did.
-- ============================================================================

grant select on public.brand_profile to pipeline_worker;

drop policy if exists "worker reads brand profile" on public.brand_profile;
create policy "worker reads brand profile" on public.brand_profile
  for select to pipeline_worker using (true);


-- ============================================================================
-- VERIFY — one result set. Every row should say ok = true.
-- ============================================================================

select check_name, ok
from (values
  ('worker can read brand profile',
     has_table_privilege('pipeline_worker', 'public.brand_profile', 'SELECT')),
  ('worker cannot write brand profile',
     not has_table_privilege('pipeline_worker', 'public.brand_profile', 'INSERT')
     and not has_table_privilege('pipeline_worker', 'public.brand_profile', 'UPDATE'))
) as checks (check_name, ok)
order by ok, check_name;
