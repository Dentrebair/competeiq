-- ============================================================================
-- REAL-LEAD — verify + fix grants on competitor_suggestions
--
-- Standalone, idempotent, safe to run any number of times. Diagnostic only for
-- the SELECT at the bottom; the grants above are re-issued unconditionally,
-- which is a no-op if they are already correct.
--
-- Context: the app started reporting "permission denied for table
-- competitor_suggestions" from suggestCompetitors() (an upsert), even though
-- 05-intelligence-layer.sql already grants select/insert/update/delete to
-- authenticated and defines RLS policies for all four. Postgres reports
-- "permission denied for table X" specifically for a missing table-level GRANT
-- (an RLS policy alone never produces that wording — a policy that denies a
-- row just returns zero rows). So the grant that should exist from 05 is
-- either missing or was reverted on this project — this file re-asserts it
-- without requiring a re-run of every earlier migration.
-- ============================================================================

grant select, delete on public.competitor_suggestions to authenticated;
grant insert (domain, name, url, platform, verified, evidence, rationale, status)
  on public.competitor_suggestions to authenticated;
grant update (name, url, platform, verified, evidence, rationale, status)
  on public.competitor_suggestions to authenticated;

-- Also required: RLS must be on and all four policies must exist. Re-create
-- them the same way 05 does — drop-if-exists then create, so this is safe even
-- if they are already there.
alter table public.competitor_suggestions enable row level security;

drop policy if exists "operator reads suggestions"   on public.competitor_suggestions;
drop policy if exists "operator inserts suggestions" on public.competitor_suggestions;
drop policy if exists "operator updates suggestions" on public.competitor_suggestions;
drop policy if exists "operator deletes suggestions" on public.competitor_suggestions;

create policy "operator reads suggestions" on public.competitor_suggestions
  for select to authenticated using (true);
create policy "operator inserts suggestions" on public.competitor_suggestions
  for insert to authenticated with check (true);
create policy "operator updates suggestions" on public.competitor_suggestions
  for update to authenticated using (true) with check (true);
create policy "operator deletes suggestions" on public.competitor_suggestions
  for delete to authenticated using (true);


-- ============================================================================
-- VERIFY — one result set, showing exactly what authenticated can do now.
-- ============================================================================

select grantee, privilege_type, is_grantable
from information_schema.table_privileges
where table_schema = 'public'
  and table_name = 'competitor_suggestions'
  and grantee = 'authenticated'
order by privilege_type;
