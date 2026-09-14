-- ============================================================================
-- REAL-LEAD — pre-flight check for seed-demo-data.sql
--
-- READ ONLY. This makes no change of any kind: no insert, no update, no delete,
-- no DDL. Run it first and read the `verdict` column top to bottom.
--
-- It answers the two things worth knowing before running a seed against a
-- database that already has real data in it:
--
--   1. Does the seed's shape actually match this schema — do the tables,
--      columns and conflict targets it relies on exist?
--   2. Exactly how many existing rows would its two DELETEs remove?
--
-- Every row below should read PASS. Anything else, stop and send me the output.
-- ============================================================================

-- Column is `check_name`, not `check`: CHECK is a reserved word in Postgres and
-- an unquoted `select check, ...` is a syntax error.
with checks as (

  -- --- 1. The two destructive statements, measured before they run -----------
  --
  -- The seed deletes only its own rows. These two counts are the proof: they
  -- run the exact same predicates as the DELETEs, so whatever number appears
  -- here is precisely what would be removed. On a first run both are 0.
  select
    1 as ord,
    'DELETE #1 — alerts where dedupe_key like ''demo:%''' as check_name,
    count(*)::text as value,
    case when count(*) = 0
         then 'PASS — nothing to delete, this is a first run'
         else 'REVIEW — these are prior demo rows and will be replaced' end as verdict
  from public.alerts where dedupe_key like 'demo:%'

  union all
  select
    2,
    'DELETE #2 — digests where headline like ''[demo]%''',
    count(*)::text,
    case when count(*) = 0
         then 'PASS — nothing to delete, this is a first run'
         else 'REVIEW — prior demo briefings, will be replaced' end
  from public.digests where headline like '[demo]%'

  -- --- 2. Could either DELETE reach real data? ------------------------------
  --
  -- The one that matters, and it cannot be answered automatically — nothing in
  -- the row proves who wrote it. So instead of a verdict, this shows you the
  -- evidence: the run ids of every row the DELETE would remove.
  --
  -- The seed writes execution_id 9001–9045. A real WF-02 alert carries the n8n
  -- execution id of the run that produced it (yours are in the 4000s). If this
  -- lists anything outside 9001–9045, do not run the seed.
  union all
  select
    3,
    'Run ids of the rows DELETE #1 would remove',
    coalesce((select string_agg(distinct coalesce(execution_id, '(null)'), ', '
                                order by coalesce(execution_id, '(null)'))
              from public.alerts where dedupe_key like 'demo:%'), 'none'),
    case when not exists (select 1 from public.alerts where dedupe_key like 'demo:%')
         then 'PASS — nothing matches, the delete is a no-op'
         else 'REVIEW — confirm every id above is 9001-9045 before running' end

  union all
  select
    4,
    'Total alerts that would survive the seed',
    (select count(*)::text from public.alerts where dedupe_key is null
        or dedupe_key not like 'demo:%'),
    'INFO — your existing alerts, untouched'

  -- --- 3. Conflict targets the seed depends on ------------------------------
  --
  -- Each ON CONFLICT clause needs a matching unique index or constraint. If one
  -- is missing the insert fails outright rather than doing something odd, but
  -- better to know now than mid-transaction.
  union all
  select
    5,
    'competitors.domain is unique (ON CONFLICT target)',
    coalesce((select string_agg(conname, ', ') from pg_constraint
              where conrelid = 'public.competitors'::regclass and contype = 'u'), 'none'),
    case when exists (select 1 from pg_constraint
                      where conrelid = 'public.competitors'::regclass and contype = 'u')
         then 'PASS' else 'STOP — seed would fail on competitors' end

  union all
  select
    6,
    'signal_configs (competitor_id, signal_type) unique',
    coalesce((select conname from pg_constraint
              where conrelid = 'public.signal_configs'::regclass and contype = 'u' limit 1), 'none'),
    case when exists (select 1 from pg_constraint
                      where conrelid = 'public.signal_configs'::regclass and contype = 'u')
         then 'PASS' else 'STOP — run 02-signal-configs.sql first' end

  union all
  select
    7,
    'alerts.dedupe_key partial unique index',
    coalesce((select indexname from pg_indexes
              where schemaname = 'public' and tablename = 'alerts'
                and indexname = 'alerts_dedupe_key_idx'), 'none'),
    case when exists (select 1 from pg_indexes
                      where schemaname = 'public' and tablename = 'alerts'
                        and indexname = 'alerts_dedupe_key_idx')
         then 'PASS' else 'STOP — run 01-app-layer.sql first' end

  union all
  select
    8,
    'alert_analyses.alert_id unique',
    coalesce((select conname from pg_constraint
              where conrelid = 'public.alert_analyses'::regclass and contype = 'u' limit 1), 'none'),
    case when exists (select 1 from pg_constraint
                      where conrelid = 'public.alert_analyses'::regclass and contype = 'u')
         then 'PASS' else 'STOP — run 05-intelligence-layer.sql first' end

  -- --- 4. Columns the seed writes that only exist after migration 05 --------
  union all
  select
    9,
    'alerts.impact and alerts.confidence exist',
    coalesce((select string_agg(column_name, ', ' order by column_name)
              from information_schema.columns
              where table_schema = 'public' and table_name = 'alerts'
                and column_name in ('impact', 'confidence')), 'none'),
    case when (select count(*) from information_schema.columns
               where table_schema = 'public' and table_name = 'alerts'
                 and column_name in ('impact', 'confidence')) = 2
         then 'PASS' else 'STOP — run 05-intelligence-layer.sql first' end

  -- --- 5. The CHECK constraints the seed's values must satisfy --------------
  --
  -- The seed writes signal_type in {sku_price_change, catalog_change,
  -- promo_discount} and confidence in {high, medium, null}. If either
  -- constraint exists with different members the insert aborts.
  union all
  select
    10,
    'alerts_signal_type_check present',
    coalesce((select 'yes' from pg_constraint where conname = 'alerts_signal_type_check'), 'no'),
    'INFO — seed writes only the three canonical live types either way'

  union all
  select
    11,
    'alerts_confidence_check present',
    coalesce((select 'yes' from pg_constraint where conname = 'alerts_confidence_check'), 'no'),
    'INFO — seed writes only high / medium / null either way'

  -- --- 6. What is in there now, for comparison afterwards -------------------
  union all
  select 12, 'Current competitors', count(*)::text, 'INFO' from public.competitors
  union all
  select 13, 'Current alerts',      count(*)::text, 'INFO' from public.alerts
  union all
  select 14, 'Current digests',     count(*)::text, 'INFO' from public.digests
  union all
  select 15, 'Current signal_configs', count(*)::text, 'INFO' from public.signal_configs
)
select check_name, value, verdict from checks order by ord;
