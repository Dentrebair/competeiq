-- ============================================================================
-- REAL-LEAD — make alerts.dedupe_key usable by ON CONFLICT
--
-- Run any time after 01-app-layer.sql. Idempotent. No data is deleted.
--
-- The bug: 01-app-layer.sql §1.2 created dedupe_key's unique index as a PARTIAL
-- index —
--
--     create unique index alerts_dedupe_key_idx
--       on public.alerts (dedupe_key) where dedupe_key is not null;
--
-- and in the same breath told n8n to insert with ?on_conflict=dedupe_key.
-- Those two cannot work together. Postgres will only infer a partial index for
-- ON CONFLICT if the statement repeats the index predicate
-- (ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL), and PostgREST emits
-- no predicate at all. So every insert from WF-02 fails with
--
--     42P10: there is no unique or exclusion constraint matching the
--            ON CONFLICT specification
--
-- Observed on n8n execution 4273 (2026-08-27): all 10 promo alerts for Death
-- Wish Coffee were generated correctly and then rejected here. This was never
-- a bad column or a bad payload — the constraint simply was not inferrable.
--
-- The fix: drop the predicate. The comment in 01 justified the WHERE clause by
-- saying existing null rows must not collide with each other — but a plain
-- unique index already guarantees that. Postgres treats NULLs as DISTINCT in a
-- unique index by default (NULLS NOT DISTINCT is opt-in, Postgres 15+), so any
-- number of rows may keep dedupe_key null. The predicate bought nothing and
-- cost the ON CONFLICT inference.
--
-- Safe to run: the partial index has been enforcing uniqueness over exactly the
-- non-null rows all along, so no duplicate can exist to block the new index.
-- The index name is unchanged, so preflight-seed-check.sql's check for
-- `alerts_dedupe_key_idx` still passes.
-- ============================================================================

begin;

drop index if exists public.alerts_dedupe_key_idx;

create unique index alerts_dedupe_key_idx
  on public.alerts (dedupe_key);

commit;

-- ----------------------------------------------------------------------------
-- Verify — expect one row, indexdef with NO "WHERE" clause on the end.
-- ----------------------------------------------------------------------------

select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename = 'alerts'
  and indexname = 'alerts_dedupe_key_idx';
