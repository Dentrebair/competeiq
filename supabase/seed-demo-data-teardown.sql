-- ============================================================================
-- REAL-LEAD — remove the demo data
--
-- Run this when you are done looking at the populated dashboard, so the
-- database holds nothing but what Apify and n8n actually produced.
--
-- It removes exactly what seed-demo-data.sql created: three demo competitors
-- and everything hanging off them. Your real competitor and its alerts are
-- never referenced — the separation is structural, not a naming convention, so
-- there is no pattern here that could accidentally match a real row.
--
-- Safe to run twice. Safe to run if the seed was never applied.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- Order matters, and getting it wrong fails loudly rather than silently.
--
--   alerts         -> references competitors with NO cascade, so these must go
--                     first or the competitor delete aborts on a foreign key.
--   alert_analyses -> cascades from alerts, so it goes with them.
--   conversations  -> also cascades from alerts. Any chat opened against a demo
--                     alert disappears with it, which is correct: the anchor is
--                     gone, and an unanchored conversation is exactly what the
--                     schema's CHECK constraint forbids.
--   signal_configs -> cascades from competitors.
-- ----------------------------------------------------------------------------

delete from public.alerts
 where competitor_id in (
   select id from public.competitors
    where domain in ('bonescoffee.com', 'blackriflecoffee.com', 'chamberlaincoffee.com')
 );

delete from public.digests where headline like '[demo]%';

-- ----------------------------------------------------------------------------
-- The competitors themselves.
--
-- 03-ownership-hardening.sql installs a trigger that blocks deleting a
-- competitor while any of its signals still holds a live `apify_schedule_id` —
-- otherwise the Apify schedule keeps running and keeps billing with nothing in
-- the database referencing it.
--
-- Demo competitors were inserted straight into Postgres and never went through
-- the Config Loader, so they have no schedule ids and the trigger will not fire.
-- If it does fire, that means one of these was somehow registered with Apify:
-- stop, cancel the schedule through n8n, and only then delete.
-- ----------------------------------------------------------------------------
delete from public.competitors
 where domain in ('bonescoffee.com', 'blackriflecoffee.com', 'chamberlaincoffee.com');

commit;

-- ============================================================================
-- VERIFY — everything demo should be zero, your real data untouched
-- ============================================================================
select
  'demo competitors remaining' as check_name,
  (select count(*)::text from public.competitors
    where domain in ('bonescoffee.com','blackriflecoffee.com','chamberlaincoffee.com')) as value,
  'expect 0' as expected
union all
select
  'demo alerts remaining',
  (select count(*)::text from public.alerts where dedupe_key like 'demo:%'),
  'expect 0'
union all
select
  'demo briefings remaining',
  (select count(*)::text from public.digests where headline like '[demo]%'),
  'expect 0'
union all
select
  'your real competitors',
  (select count(*)::text from public.competitors),
  'expect 1 — Death Wish Coffee'
union all
select
  'your real alerts',
  (select count(*)::text from public.alerts),
  'expect 39 — unchanged throughout';
