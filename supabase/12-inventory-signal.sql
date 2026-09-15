-- ============================================================================
-- REAL-LEAD — inventory_status: the eighth signal
--
-- Run AFTER 11-run-progress-and-delete.sql. Idempotent.
--
-- The Shopify scraper actor already returns stock/availability data on every
-- product (`available`, `fullyOutOfStock` — confirmed against a real dataset
-- item, test/fixtures/apify/deathwish-2026-08-23.json) — it was simply never
-- read. This adds the Baseline column needed to detect a flip (in stock <->
-- out of stock) and widens both signal_type vocabularies to allow it.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Baseline gets a stock flag, alongside last_price
-- ----------------------------------------------------------------------------

alter table public.competitor_products
  add column if not exists last_in_stock boolean;


-- ----------------------------------------------------------------------------
-- 2. Widen signal_configs.signal_type — found dynamically, since it was never
--    given an explicit name at table creation (02-signal-configs.sql).
-- ----------------------------------------------------------------------------

do $$
declare
  existing_name text;
begin
  select conname into existing_name
    from pg_constraint
   where conrelid = 'public.signal_configs'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%signal_type%';

  if existing_name is not null then
    execute format('alter table public.signal_configs drop constraint %I', existing_name);
  end if;

  alter table public.signal_configs
    add constraint signal_configs_signal_type_check
    check (signal_type in (
      'sku_price_change', 'catalog_change', 'promo_discount', 'ad_creative',
      'review_sentiment', 'website_change', 'newsletter', 'inventory_status'));
end $$;


-- ----------------------------------------------------------------------------
-- 3. Widen alerts.signal_type — same "check existing data first" caution as
--    03-ownership-hardening.sql, since alerts already holds production rows.
-- ----------------------------------------------------------------------------

do $$
declare
  bad_count int;
  bad_values text;
begin
  select count(*), string_agg(distinct signal_type, ', ')
    into bad_count, bad_values
    from public.alerts
   where signal_type not in (
     'sku_price_change', 'catalog_change', 'promo_discount', 'ad_creative',
     'review_sentiment', 'website_change', 'newsletter', 'inventory_status');

  if bad_count = 0 then
    alter table public.alerts drop constraint if exists alerts_signal_type_check;
    alter table public.alerts
      add constraint alerts_signal_type_check
      check (signal_type in (
        'sku_price_change', 'catalog_change', 'promo_discount', 'ad_creative',
        'review_sentiment', 'website_change', 'newsletter', 'inventory_status'));
    raise notice 'alerts_signal_type_check widened to include inventory_status.';
  else
    raise notice
      'SKIPPED alerts_signal_type_check: % row(s) use unrecognised signal_type values (%). '
      'Reconcile or clean the rows, then re-run this file.',
      bad_count, bad_values;
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- 4. Backfill: every competitor that predates this file gets an
--    inventory_status row too, same defaults addCompetitor() seeds with.
-- ----------------------------------------------------------------------------

insert into public.signal_configs (competitor_id, signal_type, frequency_hours, enabled)
select c.id, 'inventory_status', 24, true
  from public.competitors c
 where not exists (
   select 1 from public.signal_configs sc
    where sc.competitor_id = c.id and sc.signal_type = 'inventory_status'
 );


-- ============================================================================
-- VERIFY — one result set. Every row should say ok = true.
-- ============================================================================

select check_name, ok
from (values
  ('competitor_products.last_in_stock exists',
     exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'competitor_products'
          and column_name = 'last_in_stock'
     )),
  ('signal_configs accepts inventory_status',
     (select pg_get_constraintdef(oid) ilike '%inventory_status%'
        from pg_constraint
       where conrelid = 'public.signal_configs'::regclass
         and contype = 'c' and pg_get_constraintdef(oid) ilike '%signal_type%')),
  ('alerts accepts inventory_status',
     coalesce((select pg_get_constraintdef(oid) ilike '%inventory_status%'
        from pg_constraint where conname = 'alerts_signal_type_check'), false)),
  ('every competitor has an inventory_status config',
     (select count(*) from public.competitors) =
     (select count(*) from public.signal_configs where signal_type = 'inventory_status')
  )
) as checks (check_name, ok)
order by ok, check_name;
