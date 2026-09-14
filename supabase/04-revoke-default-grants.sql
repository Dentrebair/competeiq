-- ============================================================================
-- REAL-LEAD — revoke Supabase's default grants
--
-- Run AFTER 03-ownership-hardening.sql. Idempotent.
--
-- Why this is needed: Supabase grants `anon` and `authenticated` full table
-- privileges on the public schema by default. 03 revoked and re-granted UPDATE
-- and INSERT on competitors and signal_configs, but left everything else at the
-- default — so `authenticated` still holds INSERT on all 21 alerts columns,
-- INSERT and UPDATE on every digests column, and both on competitor_products.
--
-- RLS blocks all of that today (no INSERT policy on alerts, no UPDATE policy on
-- digests, no policies at all on competitor_products). That is exactly the
-- problem: it makes RLS a single point of failure. Add one over-broad policy in
-- six months and these grants go live behind it. Privileges and policies should
-- both have to be wrong before anything leaks.
--
-- None of this affects n8n. The service role bypasses RLS and holds its own
-- grants; WF-02 keeps writing alerts and competitor_products exactly as now.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- alerts — read, and flip read state. Nothing else.
--
-- Revoking table-level INSERT also drops every column-level INSERT grant for
-- that privilege, so the 21 rows in your verification output disappear together.
-- SELECT is kept (the feed) and the column-scoped UPDATE from 03 survives,
-- because revoking INSERT and DELETE does not touch UPDATE.
-- ----------------------------------------------------------------------------
revoke insert, delete, truncate, references, trigger on public.alerts from authenticated;
revoke all on public.alerts from anon;

-- ----------------------------------------------------------------------------
-- competitor_products — n8n's private price-diff state.
--
-- RLS is on with zero policies, so the app already reads nothing. Removing the
-- grants makes that structural rather than policy-dependent.
-- ----------------------------------------------------------------------------
revoke all on public.competitor_products from authenticated;
revoke all on public.competitor_products from anon;

-- ----------------------------------------------------------------------------
-- digests — read, plus inserting the lock row.
--
-- The app's only write is `insert({ status: 'generating' })` to take the digest
-- lock. WF-03 owns every content column. Scoping INSERT to `status` means an app
-- bug cannot fabricate a digest with a headline and a priority action that no
-- model ever produced — which would be indistinguishable from a real one in the
-- UI.
-- ----------------------------------------------------------------------------
revoke insert, update, delete, truncate, references, trigger on public.digests from authenticated;
grant  insert (status) on public.digests to authenticated;
revoke all on public.digests from anon;

-- ----------------------------------------------------------------------------
-- competitors / signal_configs — already scoped correctly by 03.
-- Just close off `anon`, which has no business here at all.
-- ----------------------------------------------------------------------------
revoke all on public.competitors    from anon;
revoke all on public.signal_configs from anon;

-- ============================================================================
-- VERIFY — one query, deliberately
--
-- The Supabase SQL Editor only displays the result of the LAST statement in a
-- script, which is why the earlier files' first verification queries never
-- appeared for you. Everything worth checking is folded into this one result.
--
-- Expected:
--   alerts               rls=t  policies=2  realtime=t  table=SELECT           cols=UPDATE(is_read,read_at)
--   competitors          rls=t  policies=4  realtime=f  table=SELECT,DELETE    cols=INSERT/UPDATE(name,domain,url,active,id)
--   signal_configs       rls=t  policies=4  realtime=f  table=SELECT,DELETE    cols=INSERT/UPDATE(frequency_hours,enabled,...)
--   digests              rls=t  policies=2  realtime=t  table=SELECT           cols=INSERT(status)
--   competitor_products  rls=t  policies=0  realtime=f  table=(none)           cols=(none)
--
-- Two things to check hardest:
--   * every rls_enabled is `true`
--   * alerts and digests both show realtime=true — without that the feed
--     subscribes successfully and then receives nothing, forever
-- ============================================================================

select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,

  (select count(*) from pg_policies p
    where p.schemaname = 'public' and p.tablename = c.relname) as policies,

  exists (
    select 1 from pg_publication_tables pt
     where pt.pubname = 'supabase_realtime'
       and pt.schemaname = 'public' and pt.tablename = c.relname
  ) as realtime,

  coalesce((
    select string_agg(distinct tp.privilege_type, ', ' order by tp.privilege_type)
      from information_schema.table_privileges tp
     where tp.grantee = 'authenticated'
       and tp.table_schema = 'public' and tp.table_name = c.relname
  ), '—') as table_grants,

  coalesce((
    select string_agg(x.entry, ' | ' order by x.entry)
      from (
        select cp.privilege_type || '(' ||
               string_agg(cp.column_name, ',' order by cp.column_name) || ')' as entry
          from information_schema.column_privileges cp
         where cp.grantee = 'authenticated'
           and cp.table_schema = 'public' and cp.table_name = c.relname
         group by cp.privilege_type
      ) x
  ), '—') as column_grants,

  coalesce((
    select string_agg(distinct tp.privilege_type, ', ' order by tp.privilege_type)
      from information_schema.table_privileges tp
     where tp.grantee = 'anon'
       and tp.table_schema = 'public' and tp.table_name = c.relname
  ), '—') as anon_grants

from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relname in ('alerts', 'competitors', 'signal_configs', 'digests', 'competitor_products')
order by c.relname;
