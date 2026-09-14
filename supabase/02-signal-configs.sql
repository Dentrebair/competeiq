-- ============================================================================
-- REAL-LEAD — signal_configs
--
-- Run AFTER 01-app-layer.sql. Additive, idempotent.
--
-- Why this exists: the Config Loader contract sends seven signal configs per
-- competitor, each with its own frequency_hours and enabled flag. The app has to
-- persist them or the management page cannot render the operator's current
-- settings after a reload — and `competitors.apify_task_id` is a single column,
-- so it cannot track seven separate Apify schedules either.
--
-- The app owns *desired* state here. Apify owns *actual* state. A drift between
-- them is a reconciliation problem to surface later, not something that should
-- block a page from rendering.
-- ============================================================================

create table if not exists public.signal_configs (
  id               uuid primary key default gen_random_uuid(),
  competitor_id    uuid not null references public.competitors (id) on delete cascade,

  -- Wire contract with n8n's Config Loader. Keep these strings in step with
  -- SIGNAL_TYPES in lib/n8n.ts — n8n maps each to an Apify actor and a cron
  -- expression, so a mismatch silently stops that signal being scheduled.
  signal_type      text not null check (signal_type in (
                     'sku_price_change',
                     'catalog_change',
                     'promo_discount',
                     'ad_creative',
                     'review_sentiment',
                     'website_change',
                     'newsletter')),

  -- Hours between runs. n8n converts this to a cron expression.
  -- Bounded: below 1 hour will exhaust Apify quota fast, and above a week the
  -- intelligence is stale enough to be misleading.
  frequency_hours  integer not null default 24
                     check (frequency_hours between 1 and 168),
  enabled          boolean not null default true,

  -- Returned by Config Loader per signal, if n8n hands it back. Nullable: a row
  -- can exist as desired state before Apify has confirmed a schedule.
  apify_schedule_id text,

  -- Last outcome, for showing the operator that a signal is silently failing
  -- rather than simply quiet.
  last_run_at      timestamptz,
  last_error       text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- One config per competitor per signal. Also gives the app a clean upsert
  -- target: on_conflict=competitor_id,signal_type
  constraint signal_configs_unique unique (competitor_id, signal_type)
);

create index if not exists signal_configs_competitor_idx
  on public.signal_configs (competitor_id);

create index if not exists signal_configs_enabled_idx
  on public.signal_configs (competitor_id) where enabled = true;

-- --- updated_at maintenance -------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists signal_configs_touch on public.signal_configs;
create trigger signal_configs_touch
  before update on public.signal_configs
  for each row execute function public.touch_updated_at();

-- --- RLS --------------------------------------------------------------------
-- The operator manages these from the UI, so full CRUD under their own session.

alter table public.signal_configs enable row level security;

drop policy if exists "operator reads signal_configs"   on public.signal_configs;
drop policy if exists "operator inserts signal_configs" on public.signal_configs;
drop policy if exists "operator updates signal_configs" on public.signal_configs;
drop policy if exists "operator deletes signal_configs" on public.signal_configs;

create policy "operator reads signal_configs" on public.signal_configs
  for select to authenticated using (true);
create policy "operator inserts signal_configs" on public.signal_configs
  for insert to authenticated with check (true);
create policy "operator updates signal_configs" on public.signal_configs
  for update to authenticated using (true) with check (true);
create policy "operator deletes signal_configs" on public.signal_configs
  for delete to authenticated using (true);

-- ============================================================================
-- Backfill: give every existing competitor the seven signals at sane defaults,
-- so the management page has something to render immediately.
--
-- Frequencies match the example payload in the webhook contract. ON CONFLICT
-- DO NOTHING means re-running never overwrites a frequency the operator has
-- since tuned.
-- ============================================================================

insert into public.signal_configs (competitor_id, signal_type, frequency_hours, enabled)
select c.id, v.signal_type, v.frequency_hours, true
  from public.competitors c
 cross join (values
    ('sku_price_change',  3),
    ('catalog_change',   24),
    ('promo_discount',    3),
    ('ad_creative',       8),
    ('review_sentiment', 24),
    ('website_change',    8),
    ('newsletter',       24)
 ) as v(signal_type, frequency_hours)
on conflict (competitor_id, signal_type) do nothing;

-- ============================================================================
-- Verify
-- ============================================================================

-- Expect 7 rows per competitor.
select c.name, count(sc.id) as signal_count
  from public.competitors c
  left join public.signal_configs sc on sc.competitor_id = c.id
 group by c.name
 order by c.name;
