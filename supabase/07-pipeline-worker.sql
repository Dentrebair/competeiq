-- ============================================================================
-- REAL-LEAD — pipeline worker
--
-- Run AFTER 06-dedupe-key-index-fix.sql. Idempotent.
--
-- The database side of replacing n8n (ADR-0003, docs/app-intelligence-migration-spec.md):
--
--   1. Two logins, each able to do exactly one job:
--        pipeline_worker  the Railway worker. Writes Alerts, the Baseline,
--                         Baseline History, digests and run status.
--        pipeline_intake  the website. Adds jobs to the queue and nothing else.
--      Neither is the service role, and both stay subject to RLS.
--   2. The `pgboss` schema, where the worker installs its job queue.
--   3. pipeline_state: the live/paused switch and the worker heartbeat.
--   4. baseline_history: what each run changed in the Baseline, so one bad run
--      can be reversed without touching later ones.
--
-- The logins are created WITHOUT passwords, so nothing can connect as them yet.
-- Set each password yourself afterwards, in a separate query you do not save:
--
--   alter role pipeline_worker with password '<openssl rand -hex 32>';
--   alter role pipeline_intake with password '<openssl rand -hex 32>';
--
-- Never commit a password to this file.
-- ============================================================================


-- ============================================================================
-- PART 1 — LOGINS
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'pipeline_worker') then
    create role pipeline_worker with login noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'pipeline_intake') then
    create role pipeline_intake with login noinherit;
  end if;
end
$$;

grant usage on schema public to pipeline_worker;


-- ============================================================================
-- PART 2 — QUEUE SCHEMA
--
-- The worker needs CREATE here because pg-boss creates a table per queue. It
-- runs with `createSchema: false`, since it cannot create schemas itself, and it
-- owns every object it creates in here. That is also why the worker, not this
-- file, grants pipeline_intake its rights on those objects each time it starts.
-- Owning pgboss gives no rights on public.
-- ============================================================================

create schema if not exists pgboss;

revoke all on schema pgboss from public;
grant usage, create on schema pgboss to pipeline_worker;
grant usage         on schema pgboss to pipeline_intake;


-- ============================================================================
-- PART 3 — NEW TABLES
-- ============================================================================

-- One row. `mode` starts paused, so a freshly deployed worker starts no scrapes
-- and takes no jobs until it is deliberately switched live:
--
--   update public.pipeline_state set mode = 'live';
create table if not exists public.pipeline_state (
  singleton     boolean primary key default true check (singleton),
  mode          text not null default 'paused' check (mode in ('live', 'paused')),
  -- Written by the worker every minute. Older than 5 minutes means it stopped.
  heartbeat_at  timestamptz
);

insert into public.pipeline_state (singleton) values (true)
on conflict (singleton) do nothing;

-- One row per product a run added to the Baseline or re-priced. Reversing run R
-- for competitor C: delete the products R added, and put previous_price back
-- on the ones it changed.
create table if not exists public.baseline_history (
  id              bigint generated always as identity primary key,
  run_id          text not null,
  competitor_id   uuid not null references public.competitors (id) on delete cascade,
  product_handle  text not null,
  was_new         boolean not null,
  previous_price  numeric,
  current_price   numeric,
  recorded_at     timestamptz not null default now()
);

create index if not exists baseline_history_run_idx
  on public.baseline_history (competitor_id, run_id);


-- ============================================================================
-- PART 4 — PRIVILEGES
--
-- Supabase grants anon and authenticated everything on new public tables by
-- default. Take that back first, then grant exactly what each role needs.
-- ============================================================================

revoke all on public.pipeline_state   from anon, authenticated;
revoke all on public.baseline_history from anon, authenticated;

-- The operator's health bar reads the switch and the heartbeat.
grant select on public.pipeline_state to authenticated;

-- --- pipeline_worker -------------------------------------------------------
grant select on public.competitors to pipeline_worker;

grant select                        on public.signal_configs to pipeline_worker;
grant update (last_run_at, last_error) on public.signal_configs to pipeline_worker;

grant select on public.alerts to pipeline_worker;
grant insert (
  workflow, execution_id, competitor_id, competitor_name, signal_type, severity,
  summary, impact, recommended_action, product_title, product_handle, product_url,
  currency, previous_price, current_price, delta_pct, ai_available, dedupe_key
) on public.alerts to pipeline_worker;
grant usage on sequence public.alerts_id_seq to pipeline_worker;

grant select, insert, update on public.competitor_products to pipeline_worker;
grant select, insert         on public.baseline_history    to pipeline_worker;

-- The digest job fills in the row the app locked. Same columns WF-03 wrote.
grant select on public.digests to pipeline_worker;
grant update (
  status, headline, priority_action, patterns, quiet_competitors, alert_ids,
  alert_count, period_start, period_end, claude_usage, error, generated_at
) on public.digests to pipeline_worker;

grant select              on public.pipeline_state to pipeline_worker;
grant update (heartbeat_at) on public.pipeline_state to pipeline_worker;

-- pipeline_intake gets nothing in public, by design.


-- ============================================================================
-- PART 5 — ROW LEVEL SECURITY
--
-- Privileges decide which columns; policies decide which rows. Both have to
-- allow a write before it happens, the same rule 03 and 04 set for the app.
-- ============================================================================

alter table public.pipeline_state   enable row level security;
alter table public.baseline_history enable row level security;

drop policy if exists "operator reads pipeline state" on public.pipeline_state;
create policy "operator reads pipeline state" on public.pipeline_state
  for select to authenticated using (true);

drop policy if exists "worker reads competitors" on public.competitors;
create policy "worker reads competitors" on public.competitors
  for select to pipeline_worker using (true);

drop policy if exists "worker reads signal configs" on public.signal_configs;
create policy "worker reads signal configs" on public.signal_configs
  for select to pipeline_worker using (true);

drop policy if exists "worker records run status" on public.signal_configs;
create policy "worker records run status" on public.signal_configs
  for update to pipeline_worker using (true) with check (true);

drop policy if exists "worker reads alerts" on public.alerts;
create policy "worker reads alerts" on public.alerts
  for select to pipeline_worker using (true);

drop policy if exists "worker writes alerts" on public.alerts;
create policy "worker writes alerts" on public.alerts
  for insert to pipeline_worker with check (true);

drop policy if exists "worker maintains baseline" on public.competitor_products;
create policy "worker maintains baseline" on public.competitor_products
  for all to pipeline_worker using (true) with check (true);

drop policy if exists "worker reads baseline history" on public.baseline_history;
create policy "worker reads baseline history" on public.baseline_history
  for select to pipeline_worker using (true);

drop policy if exists "worker records baseline history" on public.baseline_history;
create policy "worker records baseline history" on public.baseline_history
  for insert to pipeline_worker with check (true);

drop policy if exists "worker reads digests" on public.digests;
create policy "worker reads digests" on public.digests
  for select to pipeline_worker using (true);

drop policy if exists "worker completes digests" on public.digests;
create policy "worker completes digests" on public.digests
  for update to pipeline_worker using (true) with check (true);

drop policy if exists "worker reads pipeline state" on public.pipeline_state;
create policy "worker reads pipeline state" on public.pipeline_state
  for select to pipeline_worker using (true);

drop policy if exists "worker writes heartbeat" on public.pipeline_state;
create policy "worker writes heartbeat" on public.pipeline_state
  for update to pipeline_worker using (true) with check (true);


-- ============================================================================
-- VERIFY — one result set. Every row should say ok = true.
-- ============================================================================

select check_name, ok
from (values
  ('both logins exist and can log in',
     (select count(*) = 2 from pg_roles
       where rolname in ('pipeline_worker', 'pipeline_intake') and rolcanlogin)),
  ('neither login bypasses RLS',
     (select count(*) = 0 from pg_roles
       where rolname in ('pipeline_worker', 'pipeline_intake') and (rolbypassrls or rolsuper))),
  ('pipeline_state starts paused',
     (select mode = 'paused' from public.pipeline_state)),
  ('RLS on for the new tables',
     (select bool_and(relrowsecurity) from pg_class
       where oid in ('public.pipeline_state'::regclass, 'public.baseline_history'::regclass))),
  ('worker can create in pgboss',
     has_schema_privilege('pipeline_worker', 'pgboss', 'CREATE')),
  ('intake can use pgboss but not create in it',
     has_schema_privilege('pipeline_intake', 'pgboss', 'USAGE')
     and not has_schema_privilege('pipeline_intake', 'pgboss', 'CREATE')),
  ('intake cannot read alerts',
     not has_table_privilege('pipeline_intake', 'public.alerts', 'SELECT')),
  ('worker can insert an alert summary',
     has_column_privilege('pipeline_worker', 'public.alerts', 'summary', 'INSERT')),
  ('worker cannot mark alerts read',
     not has_column_privilege('pipeline_worker', 'public.alerts', 'is_read', 'UPDATE')),
  ('worker cannot rename a competitor',
     not has_column_privilege('pipeline_worker', 'public.competitors', 'name', 'UPDATE')),
  ('worker can record run status',
     has_column_privilege('pipeline_worker', 'public.signal_configs', 'last_run_at', 'UPDATE')),
  ('worker cannot change monitoring settings',
     not has_column_privilege('pipeline_worker', 'public.signal_configs', 'enabled', 'UPDATE')),
  ('worker can upsert the Baseline',
     has_table_privilege('pipeline_worker', 'public.competitor_products', 'INSERT')
     and has_table_privilege('pipeline_worker', 'public.competitor_products', 'UPDATE')),
  ('worker cannot switch itself live',
     not has_column_privilege('pipeline_worker', 'public.pipeline_state', 'mode', 'UPDATE')),
  ('operator can read pipeline state',
     has_table_privilege('authenticated', 'public.pipeline_state', 'SELECT')),
  ('operator cannot read baseline history',
     not has_table_privilege('authenticated', 'public.baseline_history', 'SELECT')),
  ('browser key reads neither new table',
     not has_table_privilege('anon', 'public.pipeline_state', 'SELECT')
     and not has_table_privilege('anon', 'public.baseline_history', 'SELECT'))
) as checks (check_name, ok)
order by ok, check_name;
