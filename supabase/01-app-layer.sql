-- ============================================================================
-- REAL-LEAD — app layer migration
--
-- Additive only. Creates nothing that already exists and alters no existing
-- column. Your tables and n8n's write paths keep working exactly as they do now.
--
-- Safe to re-run: every statement is guarded.
--
-- Order matters here: all shape changes (new columns, new tables) come first,
-- then privileges, then publication. Column-level GRANTs reference columns by
-- name, so granting before the ALTER TABLE that adds them fails with
-- 42703 "column ... does not exist".
--
-- Paste into the Supabase SQL Editor and run top to bottom. Expect
-- "Success. No rows returned."
-- ============================================================================


-- ============================================================================
-- PART 1 — SHAPE
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1.1 Read state on alerts
--
-- The feed needs to show what is new, and WF-03 is specified to summarise
-- *unread* alerts — which is currently unknowable.
-- ----------------------------------------------------------------------------

alter table public.alerts add column if not exists is_read boolean not null default false;
alter table public.alerts add column if not exists read_at timestamptz;

-- ----------------------------------------------------------------------------
-- 1.2 Idempotency
--
-- Apify retries completion webhooks, and WF-02 is fire-and-forget, so a retried
-- delivery currently writes a second identical alert. `execution_id` cannot help:
-- a retry produces a *new* n8n execution and therefore a new id.
--
-- Nullable on purpose. Existing rows stay null, and Postgres treats nulls as
-- distinct in a unique index, so they do not collide with each other. New rows
-- from n8n set it and get deduped.
--
-- n8n should set it to:   {apify_run_id}:{signal_type}:{product_handle}
-- and where there is no product:  {apify_run_id}:{signal_type}
--
-- On the Supabase REST insert, add  ?on_conflict=dedupe_key  and the header
-- `Prefer: resolution=ignore-duplicates` so a retry is a silent no-op rather
-- than a 409 that trips the workflow's error branch.
-- ----------------------------------------------------------------------------

alter table public.alerts add column if not exists dedupe_key text;

-- SUPERSEDED by 06-dedupe-key-index-fix.sql (2026-08-27). The `where` predicate
-- below makes this a PARTIAL index, and Postgres cannot infer a partial index
-- for a bare `ON CONFLICT (dedupe_key)` — which is exactly what the REST insert
-- three comment-lines up sends. Every n8n insert failed with 42P10 until 06
-- dropped the predicate. Kept as-written for history; run 06 after this.
create unique index if not exists alerts_dedupe_key_idx
  on public.alerts (dedupe_key) where dedupe_key is not null;

-- ----------------------------------------------------------------------------
-- 1.3 Feed indexes
--
-- The feed is "newest first", optionally filtered to unread or by competitor.
-- Without these, every page load is a full scan and sort of alerts.
-- ----------------------------------------------------------------------------

create index if not exists alerts_feed_idx
  on public.alerts (created_at desc);

create index if not exists alerts_unread_idx
  on public.alerts (created_at desc) where is_read = false;

create index if not exists alerts_competitor_idx
  on public.alerts (competitor_id, created_at desc);

-- ----------------------------------------------------------------------------
-- 1.4 Digests
--
-- WF-03 exists but has nowhere to put its output. Shape mirrors the WF-03 JSON
-- schema in docs/n8n-claude-calls.md.
-- ----------------------------------------------------------------------------

create table if not exists public.digests (
  id                 uuid primary key default gen_random_uuid(),
  status             text not null default 'generating'
                       check (status in ('generating', 'ready', 'failed')),

  headline           text,
  priority_action    jsonb,
  patterns           jsonb  not null default '[]'::jsonb,
  quiet_competitors  text[] not null default '{}',

  -- bigint[] because alerts.id is bigint, not uuid
  alert_ids          bigint[] not null default '{}',
  alert_count        integer,
  period_start       timestamptz,
  period_end         timestamptz,
  claude_usage       jsonb,
  error              text,

  requested_at       timestamptz not null default now(),
  generated_at       timestamptz,
  created_at         timestamptz not null default now()
);

create index if not exists digests_recent_idx
  on public.digests (generated_at desc nulls last);

-- The digest lock.
--
-- "Trigger a digest if the last one is older than 6 hours" with no lock means an
-- operator refreshing five times fires five WF-03 runs — and WF-03 is the Opus 5
-- call, the expensive one. This partial unique index allows exactly one row in
-- 'generating' at a time, which makes the race a database problem rather than an
-- application one.
--
--   1. App INSERTs status='generating'.
--        unique violation (23505) -> a run is already in flight; do nothing
--        success                  -> the app holds the lock; call n8n
--   2. App POSTs the returned digest id to the n8n Digest webhook.
--   3. WF-03 UPDATEs that row to 'ready' with content + generated_at.
--   4. App sees the UPDATE over Realtime.
--
-- Step 3 is an UPDATE, so the Realtime subscription must listen for UPDATE, not
-- just INSERT.
create unique index if not exists digests_one_in_flight_idx
  on public.digests (status) where status = 'generating';

-- Stale-lock reaper. If WF-03 dies mid-run, that 'generating' row blocks every
-- future digest forever. The app calls this before trying to take the lock.
create or replace function public.reap_stale_digests(max_age interval default '15 minutes')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  reaped integer;
begin
  update public.digests
     set status = 'failed',
         error  = 'timed out — no result from WF-03'
   where status = 'generating'
     and requested_at < now() - max_age;
  get diagnostics reaped = row_count;
  return reaped;
end;
$$;


-- ============================================================================
-- PART 2 — SECURITY
--
-- NEXT_PUBLIC_SUPABASE_ANON_KEY is delivered to every browser that loads the
-- app. That is fine and by design, but ONLY because RLS decides what the key can
-- reach. With RLS off, that key is an unauthenticated read of every alert, every
-- competitor, and every price you track.
--
-- Enabling RLS is deny-by-default: after this block, anything without a matching
-- policy returns zero rows. n8n is unaffected — the service role key bypasses RLS
-- entirely, which is why WF-02 keeps writing normally.
-- ============================================================================

alter table public.competitors         enable row level security;
alter table public.alerts              enable row level security;
alter table public.competitor_products enable row level security;
alter table public.digests             enable row level security;

-- --- competitors: the operator manages these from the UI --------------------
drop policy if exists "operator reads competitors"   on public.competitors;
drop policy if exists "operator inserts competitors" on public.competitors;
drop policy if exists "operator updates competitors" on public.competitors;
drop policy if exists "operator deletes competitors" on public.competitors;

create policy "operator reads competitors" on public.competitors
  for select to authenticated using (true);
create policy "operator inserts competitors" on public.competitors
  for insert to authenticated with check (true);
create policy "operator updates competitors" on public.competitors
  for update to authenticated using (true) with check (true);
create policy "operator deletes competitors" on public.competitors
  for delete to authenticated using (true);

-- --- alerts: read, and mark-as-read. Nothing else. -------------------------
drop policy if exists "operator reads alerts"   on public.alerts;
drop policy if exists "operator updates alerts" on public.alerts;

create policy "operator reads alerts" on public.alerts
  for select to authenticated using (true);
create policy "operator updates alerts" on public.alerts
  for update to authenticated using (true) with check (true);

-- RLS cannot restrict *which columns* an update touches, so column privileges
-- do that job. The browser can flip read state and nothing else; an attempt to
-- rewrite `severity` or `summary` fails at the grant level rather than being
-- caught by application code we'd have to remember to write.
--
-- Depends on 1.1 above having added these columns — hence the ordering.
revoke update on public.alerts from authenticated;
grant  update (is_read, read_at) on public.alerts to authenticated;

-- --- competitor_products: no policies, deliberately ------------------------
-- RLS is on with zero policies, so `authenticated` reads nothing. This is n8n's
-- working state for price diffing; the app gets product detail from the
-- denormalised product_* columns on alerts. n8n reaches it with the service role.

-- --- digests: read, plus taking the lock -----------------------------------
drop policy if exists "operator reads digests"   on public.digests;
drop policy if exists "operator inserts digests" on public.digests;

create policy "operator reads digests" on public.digests
  for select to authenticated using (true);
-- The app may only ever insert the lock row; WF-03 fills in the content.
create policy "operator inserts digests" on public.digests
  for insert to authenticated with check (status = 'generating');


-- ============================================================================
-- PART 3 — REALTIME
--
-- Realtime is a WebSocket from the browser straight to Supabase, tailing
-- Postgres replication. It never calls into Next.js. A table not in this
-- publication produces the worst failure mode in the stack: the channel reports
-- SUBSCRIBED and then silently delivers nothing, forever.
--
-- RLS applies here too — the SELECT policies above are what make delivery work.
-- ============================================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public' and tablename = 'alerts'
  ) then
    alter publication supabase_realtime add table public.alerts;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public' and tablename = 'digests'
  ) then
    alter publication supabase_realtime add table public.digests;
  end if;
end $$;

-- Puts the pre-update row in the payload, so the client can tell a
-- generating -> ready transition from a ready -> ready rewrite. Costs a little
-- extra WAL; irrelevant at this volume.
alter table public.alerts  replica identity full;
alter table public.digests replica identity full;


-- ============================================================================
-- PART 4 — VERIFY
-- ============================================================================

-- Every table should read rls_enabled = true, with policy_count > 0 except
-- competitor_products, which is intentionally 0.
select relname as table_name,
       relrowsecurity as rls_enabled,
       (select count(*) from pg_policies p
         where p.schemaname = 'public' and p.tablename = c.relname) as policy_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
 order by relname;

-- Both alerts and digests should appear here.
select tablename from pg_publication_tables
 where pubname = 'supabase_realtime' and schemaname = 'public'
 order by tablename;

-- The new columns should be present on alerts.
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public' and table_name = 'alerts'
   and column_name in ('is_read', 'read_at', 'dedupe_key')
 order by column_name;
