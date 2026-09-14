#!/usr/bin/env bash
#
# Queue integration tests against a throwaway local Postgres shaped like a new
# Supabase project: a non-superuser owner standing in for `postgres`, the anon,
# authenticated and service_role roles, Supabase's default grants, and then
# supabase/00 → 07 exactly as they run in the SQL editor.
#
# Needs PostgreSQL 16+ binaries on PATH (Homebrew: brew install postgresql@16)
# and Node 22. Usage: npm run test:queue
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${TMPDIR:-/tmp}/competeiq-queue-test"
# Unix socket paths are limited to ~103 bytes, and macOS's TMPDIR is too long.
SOCK=/tmp/competeiq-pg
PORT=54329

export LC_ALL=C
export PGOPTIONS="-c client_min_messages=warning"

pg_ctl -D "$DATA" stop -m fast >/dev/null 2>&1 || true
rm -rf "$DATA"
mkdir -p "$SOCK"
initdb -D "$DATA" -U super --auth=trust --locale=C --encoding=UTF8 >/dev/null
pg_ctl -D "$DATA" -o "-p $PORT -k $SOCK -c listen_addresses=''" -l "$DATA.log" start >/dev/null
trap 'pg_ctl -D "$DATA" stop -m fast >/dev/null 2>&1 || true' EXIT

for _ in $(seq 1 40); do
  pg_isready -h "$SOCK" -p "$PORT" >/dev/null 2>&1 && break
  sleep 0.25
done

PSQL=(psql -h "$SOCK" -p "$PORT" -X -q -v ON_ERROR_STOP=1)

"${PSQL[@]}" -U super -d postgres <<'SQL'
create role supa_postgres login createrole createdb bypassrls replication;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create database app owner supa_postgres;
SQL

"${PSQL[@]}" -U super -d app <<'SQL' 2>/dev/null
create publication supabase_realtime;
alter publication supabase_realtime owner to supa_postgres;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role supa_postgres in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges for role supa_postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role supa_postgres in schema public grant all on functions to anon, authenticated, service_role;
SQL

for file in 00-base-tables 01-app-layer 02-signal-configs 03-ownership-hardening \
            04-revoke-default-grants 05-intelligence-layer 06-dedupe-key-index-fix \
            07-pipeline-worker; do
  "${PSQL[@]}" -U supa_postgres -d app -f "$ROOT/supabase/$file.sql" >/dev/null
done

ENCODED_SOCK="%2Ftmp%2Fcompeteiq-pg"
export QUEUE_TEST_WORKER_URL="postgresql://pipeline_worker@$ENCODED_SOCK:$PORT/app"
export QUEUE_TEST_INTAKE_URL="postgresql://pipeline_intake@$ENCODED_SOCK:$PORT/app"
export QUEUE_TEST_ADMIN_URL="postgresql://super@$ENCODED_SOCK:$PORT/app"

cd "$ROOT"
npx vitest run test/queue
