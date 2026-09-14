-- ============================================================================
-- REAL-LEAD — temporary demo data
--
-- Purpose: fill the dashboard so it can be judged with realistic content on it.
-- Meant to be deleted once you have looked at it — see
-- supabase/seed-demo-data-teardown.sql, which removes every row this creates.
--
-- ---------------------------------------------------------------------------
-- It does not touch your real data, by construction rather than by filter
--
-- Every demo row belongs to one of three demo competitors, and Death Wish
-- Coffee is not one of them. Your 39 real alerts and the competitor they belong
-- to are never read, updated or deleted by this script or by the teardown. That
-- is deliberate: matching demo rows by a naming pattern is a rule someone has
-- to keep getting right, whereas keeping them on separate competitors makes the
-- separation structural.
--
-- The demo competitors are inserted straight into Postgres, so they are never
-- registered with Apify and no schedule exists for them. Nothing will try to
-- scrape them and nothing will bill for them.
--
-- SAFE TO RE-RUN. It removes its own previous rows first.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Remove any previous run
--
-- Order matters. `alerts.competitor_id` references `competitors` with no ON
-- DELETE CASCADE, so the alerts have to go before the competitors or the delete
-- fails on a foreign key. `signal_configs` does cascade, so it goes with them.
-- ----------------------------------------------------------------------------
delete from public.alerts
 where competitor_id in (
   select id from public.competitors
    where domain in ('bonescoffee.com', 'blackriflecoffee.com', 'chamberlaincoffee.com')
 );

delete from public.digests where headline like '[demo]%';

delete from public.competitors
 where domain in ('bonescoffee.com', 'blackriflecoffee.com', 'chamberlaincoffee.com');

-- ----------------------------------------------------------------------------
-- 2. Three demo competitors
-- ----------------------------------------------------------------------------
insert into public.competitors (name, domain, url, active) values
  ('Bones Coffee',        'bonescoffee.com',        'https://bonescoffee.com',        true),
  ('Black Rifle Coffee',  'blackriflecoffee.com',   'https://blackriflecoffee.com',   true),
  ('Chamberlain Coffee',  'chamberlaincoffee.com',  'https://chamberlaincoffee.com',  true);

-- ----------------------------------------------------------------------------
-- 3. Signal configs — all seven each, only the three WF-02 can service enabled
--
-- WF-02 has exactly three diff branches (price, catalog, promo). The other four
-- exist as disabled rows, which is the honest state and the one the app renders
-- as "coming soon".
-- ----------------------------------------------------------------------------
insert into public.signal_configs (competitor_id, signal_type, frequency_hours, enabled)
select c.id, s.signal_type, s.hours, s.enabled
from public.competitors c
cross join (values
  ('sku_price_change',  3, true),
  ('promo_discount',    3, true),
  ('catalog_change',   24, true),
  ('website_change',    8, false),
  ('ad_creative',       8, false),
  ('review_sentiment', 24, false),
  ('newsletter',       24, false)
) as s(signal_type, hours, enabled)
where c.domain in ('bonescoffee.com', 'blackriflecoffee.com', 'chamberlaincoffee.com');

-- ----------------------------------------------------------------------------
-- 4. Alerts
--
-- Eighteen rows, chosen to cover the states the UI actually branches on. Each
-- one exists to make something visible that you cannot otherwise see:
--
--   critical / high / medium / low  every band of the severity ramp and rail
--   ai_available = false            renders as *Unclassified*, violet + dashed,
--                                   with no severity, impact or confidence
--   impact null vs present          both the impact block and its "not yet read
--                                   against your catalogue" fallback
--   is_read true                    so the Read tab is not empty
--   positive delta_pct              a price RISE, which takes the other colour
--                                   branch from every cut on the screen
--   catalog_change                  no prices at all, so the before/after block
--                                   is correctly absent rather than blank
--   a >50% discount                 the deepest band the severity rule has
--
-- Text is written the way WF-02 writes it: two sentences, figures stated.
-- Timestamps are relative to now(), so the data is never stale.
-- ----------------------------------------------------------------------------
insert into public.alerts (
  created_at, workflow, execution_id, competitor_id, competitor_name,
  signal_type, severity, summary, recommended_action, impact, confidence,
  product_title, product_handle, product_url, currency,
  previous_price, current_price, delta_pct, ai_available, is_read, dedupe_key
)
select
  now() - (v.hours_ago || ' hours')::interval,
  'WF-02', v.run, c.id, c.name,
  v.signal_type, v.severity, v.summary, v.action, v.impact, v.confidence,
  v.product_title, v.handle,
  case when v.handle is null then null
       else 'https://' || c.domain || '/products/' || v.handle end,
  'USD', v.prev, v.curr, v.delta, v.ai, v.is_read,
  'demo:' || v.run
from (values

-- Bones Coffee ---------------------------------------------------------------
('bonescoffee.com', 2, '9001', 'sku_price_change', 'critical', true, false,
 21.99, 14.99, -31.8, 'maple-bacon-12oz', 'Maple Bacon 12oz',
 'Bones Coffee cut Maple Bacon 12oz from $21.99 to $14.99, a 32% reduction. That is a core roast at a price below their usual promotional floor.',
 'Hold your comparable roast at list and put the subscription saving above the fold on that product page this week.',
 'This lands on the single product a first-time buyer is most likely to compare, and it sits under your shelf price for the same format. Matching across the range would cost margin on every line to answer a comparison most repeat customers never make.',
 'high'),

('bonescoffee.com', 9, '9002', 'promo_discount', 'high', true, false,
 60.00, 33.00, -45.0, 'flavour-flight-pack', 'Flavour Flight Pack',
 'Bones Coffee is discounting the Flavour Flight Pack by 45%, down to $33.00. The depth suggests clearance rather than a routine offer.',
 'Put your starter bundle price beside their single-unit price on the category page rather than discounting to match.',
 'A 45% cut on a sampler is an acquisition play aimed at trial, which is the same buyer your starter bundle is built for. It is time-limited, so the pressure is on the next fortnight rather than permanent.',
 'high'),

('bonescoffee.com', 27, '9003', 'catalog_change', 'medium', true, false,
 null, null, null, 'six-flavour-sampler', 'Six-Flavour Discovery Sampler',
 'Bones Coffee added a Six-Flavour Discovery Sampler to their catalogue. It replaces the four-pack that had been their entry product since spring.',
 'Check whether your own trial pack still offers more variety per pound before deciding this is background.',
 null, 'medium'),

('bonescoffee.com', 51, '9004', 'sku_price_change', 'low', true, true,
 16.99, 16.49, -2.9, 'jamaican-me-crazy-12oz', 'Jamaican Me Crazy 12oz',
 'Bones Coffee reduced Jamaican Me Crazy 12oz from $16.99 to $16.49. A 3% adjustment, most likely rounding or a currency tweak.',
 'No action warranted. A change this small does not move a purchase decision.',
 null, 'high'),

('bonescoffee.com', 73, '9005', 'promo_discount', 'medium', true, false,
 35.00, 24.50, -30.0, 'subscription-starter', 'Subscription Starter Box',
 'Bones Coffee is running 30% off their Subscription Starter Box, now $24.50. This targets first-time subscribers rather than existing customers.',
 'Make your first-month subscription saving the headline number on the signup page, not a line at checkout.',
 'This is aimed squarely at subscription acquisition, where your own economics are strongest. The risk is not the discount itself but that it becomes the reference price a new customer anchors on.',
 'high'),

('bonescoffee.com', 122, '9006', 'catalog_change', 'low', true, true,
 null, null, null, 'seasonal-mug-2026', 'Seasonal Mug 2026',
 'Bones Coffee listed a Seasonal Mug 2026 in their merchandise range. It does not overlap any coffee product.',
 'No action warranted. Merchandise range changes do not affect your coffee positioning.',
 null, 'high'),

-- Black Rifle Coffee ---------------------------------------------------------
('blackriflecoffee.com', 5, '9010', 'promo_discount', 'high', true, false,
 60.00, 45.00, -25.0, 'free-shipping-tier', 'Free Shipping Threshold',
 'Black Rifle Coffee lowered its free shipping threshold from $60 to $45. Every basket between those two values is now cheaper to complete with them than before.',
 'Show customers how much more they need to add to unlock your own free shipping, rather than lowering the threshold to match.',
 'Shipping is the friction point closest to checkout, so this affects conversion rather than consideration. Your bundle sizes already clear most thresholds, which limits the exposure to single-item baskets.',
 'high'),

('blackriflecoffee.com', 14, '9011', 'sku_price_change', 'high', true, false,
 17.99, 15.29, -15.0, 'ac-dark-roast-12oz', 'AC Dark Roast 12oz',
 'Black Rifle Coffee reduced AC Dark Roast 12oz from $17.99 to $15.29, a 15% cut. That crosses from promotional depth into repositioning.',
 'Hold price and lead on roast date and origin on the comparable product page.',
 null, 'medium'),

('blackriflecoffee.com', 30, '9012', 'sku_price_change', 'medium', true, false,
 22.49, 24.99, 11.1, 'silencer-smooth-12oz', 'Silencer Smooth 12oz',
 'Black Rifle Coffee raised Silencer Smooth 12oz from $22.49 to $24.99, an 11% increase. This is the second rise on that line this quarter.',
 'Leave your price where it is — their increase widens your value gap without you spending anything.',
 'A competitor raising price is the cheapest advantage available. Your comparable roast now undercuts theirs by a visible margin without any change on your side.',
 'high'),

('blackriflecoffee.com', 47, '9013', 'catalog_change', 'medium', true, false,
 null, null, null, 'ready-to-drink-4pk', 'Ready-to-Drink 4-Pack',
 'Black Rifle Coffee added a Ready-to-Drink 4-Pack to their range. It is their first move into chilled format.',
 'Watch whether the next addition moves closer to your core bagged range before treating this as a category threat.',
 'Chilled ready-to-drink is a different purchase occasion from bagged coffee, so it does not compete directly today. It does put them in a fridge aisle your brand is absent from.',
 'medium'),

('blackriflecoffee.com', 68, '9014', 'sku_price_change', 'low', false, false,
 null, null, null, null, null,
 'A price change was detected on Black Rifle Coffee but the automated interpretation did not complete. The raw difference was recorded and is available in the collection log.',
 null, null, null),

('blackriflecoffee.com', 95, '9015', 'promo_discount', 'low', true, true,
 28.00, 22.40, -20.0, 'coffee-club-merch', 'Coffee Club Merch Drop',
 'Black Rifle Coffee is running 20% off a merchandise drop, down to $22.40. This is branded apparel rather than coffee.',
 'No action warranted. Merchandise discounting does not read across to coffee pricing.',
 null, 'high'),

-- Chamberlain Coffee ---------------------------------------------------------
('chamberlaincoffee.com', 7, '9020', 'promo_discount', 'critical', true, false,
 48.00, 21.60, -55.0, 'family-bundle', 'Family Bundle',
 'Chamberlain Coffee is discounting their Family Bundle by 55%, from $48.00 to $21.60. That is the deepest cut recorded on any competitor bundle this quarter.',
 'Do not match. Put your bundle''s per-cup cost beside their headline price and let the arithmetic do the work.',
 'At 55% they are almost certainly clearing stock rather than repositioning, and the price is below what a sustainable bundle costs to fulfil. Matching would set a reference price you cannot hold once their inventory clears.',
 'high'),

('chamberlaincoffee.com', 21, '9021', 'sku_price_change', 'medium', true, false,
 19.00, 17.10, -10.0, 'french-vanilla-12oz', 'French Vanilla 12oz',
 'Chamberlain Coffee reduced French Vanilla 12oz from $19.00 to $17.10, a 10% cut. It brings the line just under the $18 mark.',
 'Hold. A dollar-ninety difference on a flavoured roast rarely moves a repeat buyer.',
 null, 'medium'),

('chamberlaincoffee.com', 40, '9022', 'catalog_change', 'high', true, false,
 null, null, null, 'cold-brew-concentrate', 'Cold Brew Concentrate',
 'Chamberlain Coffee launched a Cold Brew Concentrate, their first product in the format. It is priced at the top of their range.',
 'Decide this month whether to answer with your own concentrate or cede the format — the first mover usually takes the search traffic.',
 'This is the closest a competitor has come to a format you do not sell. Concentrate buyers tend to be high-frequency, which makes it a retention question as much as an acquisition one.',
 'high'),

('chamberlaincoffee.com', 64, '9023', 'promo_discount', 'medium', true, true,
 24.00, 18.00, -25.0, 'matcha-starter', 'Matcha Starter Kit',
 'Chamberlain Coffee is running 25% off their Matcha Starter Kit, now $18.00. Matcha sits outside the coffee range you compete on.',
 'No action warranted unless you plan to enter matcha this year.',
 null, 'high'),

('chamberlaincoffee.com', 88, '9024', 'sku_price_change', 'low', true, true,
 15.50, 15.00, -3.2, 'house-blend-12oz', 'House Blend 12oz',
 'Chamberlain Coffee reduced House Blend 12oz from $15.50 to $15.00. A 3% adjustment at their entry price point.',
 'No action warranted at this size.',
 null, 'high'),

('chamberlaincoffee.com', 140, '9025', 'catalog_change', 'low', true, true,
 null, null, null, 'ceramic-pour-over', 'Ceramic Pour-Over Set',
 'Chamberlain Coffee added a Ceramic Pour-Over Set to their equipment range. Equipment is adjacent to, rather than competing with, your coffee lines.',
 'No action warranted. Equipment does not affect coffee price comparison.',
 null, 'high')

) as v(domain, hours_ago, run, signal_type, severity, ai, is_read,
       prev, curr, delta, handle, product_title, summary, action, impact, confidence)
join public.competitors c on c.domain = v.domain;

-- ----------------------------------------------------------------------------
-- 5. Two decision analyses
--
-- Normally written by the app when the operator clicks "Generate options".
-- Seeded on the two most severe alerts so the decision blocks are visible
-- without an ANTHROPIC_API_KEY — every other alert still shows the Generate
-- button, which is the state you would actually meet.
-- ----------------------------------------------------------------------------
insert into public.alert_analyses (alert_id, alternatives, deeper_impact, model)
select a.id,
  '[
    {"approach":"Hold price, lead with bundle value",
     "action":"Keep list prices where they are and move the subscription saving above the fold on the comparable product page this week.",
     "tradeoff":"Protects margin across the whole line, but concedes the headline price comparison to anyone shopping on single-unit cost alone."},
    {"approach":"Match on one SKU only",
     "action":"Drop the single comparable roast to within a dollar of theirs and leave the rest of the range untouched.",
     "tradeoff":"Removes the direct comparison a first-time buyer makes, at the cost of roughly a third of the margin on your highest-volume line."}
  ]'::jsonb,
  'This lands on the one product a first-time buyer is most likely to compare, so the effect is concentrated on trial rather than spread across the catalogue. Repeat customers buying on subscription are largely insulated — the exposure is at acquisition, not retention.',
  'demo-seed'
from public.alerts a
where a.dedupe_key in ('demo:9001', 'demo:9020');

-- ----------------------------------------------------------------------------
-- 6. One finished briefing
-- ----------------------------------------------------------------------------
insert into public.digests (
  status, headline, priority_action, patterns, quiet_competitors,
  alert_ids, alert_count, period_start, period_end, generated_at
)
select
  'ready',
  '[demo] Chamberlain cut a bundle 55% and Bones cut a core roast 32%, while Black Rifle quietly raised prices on its smooth line.',
  jsonb_build_object(
    'action', 'Hold your flagship price and put the per-cup cost of your bundle on the category page before the weekend.',
    'why_now', 'Two of the three deep cuts are time-limited clearances, and Black Rifle moving up in the same week suggests the category is not repricing — matching now would set a reference you cannot hold.',
    'competitor', 'Chamberlain Coffee',
    'related_alert_ids', to_jsonb(array(
      select a.id::text from public.alerts a
       where a.dedupe_key in ('demo:9020', 'demo:9001', 'demo:9002')))
  ),
  '[
    {"pattern":"The deepest discounts are on bundles and samplers rather than single bags, which reads as trial acquisition rather than a pricing reposition.",
     "competitors_involved":["Chamberlain Coffee","Bones Coffee"],
     "evidence_alert_ids":[]},
    {"pattern":"Black Rifle raised price in the same week two rivals cut — the category is not moving in one direction, so there is no cover for a reactive cut.",
     "competitors_involved":["Black Rifle Coffee"],
     "evidence_alert_ids":[]}
  ]'::jsonb,
  array[]::text[],
  array(select a.id from public.alerts a where a.dedupe_key like 'demo:%' and not a.is_read),
  (select count(*) from public.alerts a where a.dedupe_key like 'demo:%' and not a.is_read),
  now() - interval '7 days',
  now(),
  now() - interval '2 hours';

commit;

-- ============================================================================
-- VERIFY — one query, since the SQL Editor shows only the last result
--
-- Expect three demo rows plus your real competitor. Your real one should show
-- demo_alerts = 0: the seed never touched it.
-- ============================================================================
select
  c.name                                       as competitor,
  count(a.id)                                  as demo_alerts,
  count(*) filter (where not a.is_read)        as unread,
  count(*) filter (where not a.ai_available)   as unclassified,
  count(*) filter (where a.impact is not null) as with_impact,
  count(*) filter (where a.delta_pct > 0)      as price_rises,
  count(distinct a.signal_type)                as signal_types
from public.competitors c
left join public.alerts a
  on a.competitor_id = c.id and a.dedupe_key like 'demo:%'
group by c.name
order by demo_alerts desc, competitor;
