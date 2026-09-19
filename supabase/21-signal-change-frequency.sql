-- Track how many times a signal changed in the last 30 days.
-- Used to detect "noisy" signals (unreliable, change too frequently).

alter table public.signal_configs
  add column if not exists change_count_30d integer not null default 0;

comment on column public.signal_configs.change_count_30d is
  'Number of times this signal changed in the last 30 days. Incremented when last_change_at is set.';

-- Grant pipeline_worker UPDATE on this column.
grant update (change_count_30d) on public.signal_configs
  to pipeline_worker;

-- Verify the column exists.
select
  column_name,
  data_type,
  is_nullable
from information_schema.columns
where table_name = 'signal_configs'
  and column_name = 'change_count_30d';
