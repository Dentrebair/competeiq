-- Track when each signal last changed and last was checked.
-- Used to show "no change since X time" in the UI.

alter table public.signal_configs
  add column if not exists last_change_at timestamptz,
  add column if not exists last_checked_at timestamptz;

comment on column public.signal_configs.last_change_at is
  'When this signal last detected a change (alert generated). null = never changed.';
comment on column public.signal_configs.last_checked_at is
  'When this signal was last checked in any run (regardless of result).';

-- Verify the columns exist.
select
  count(*)::int as column_count,
  array_agg(attname) as column_names
from pg_attribute
where attrelid = 'public.signal_configs'::regclass
  and attname in ('last_change_at', 'last_checked_at');
