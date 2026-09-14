# Step 3: Worker Foundation

**Status:** Complete. All modules ready to test.

## What was built

Step 3 lays down the worker's foundation: a queue abstraction, a health-check heartbeat, graceful mode switching (live/paused), and a test harness that runs against a real database shaped like a fresh Supabase project.

### Job definitions (`lib/queue/jobs.ts`)
Centralized vocabulary for all job types, with their queue policies and worker options pinned alongside:

- **`start_scrape`** — queue policy `short` (at most one waiting per competitor). Scheduled or manually triggered. Worker polls every 10s, batch size 1.
- **`check_apify_run`** — queue policy `exclusive` (one waiting or running). Backstop for lost Apify webhooks, checks runs ~30min after start. Worker polls every 30s.
- **`process_apify_run`** — queue policy `exclusive`, with backoff and 900s expiry. Turns a finished Apify run into alerts and a new Baseline. Worker polls every 10s.
- **`generate_digest`** — queue policy `exclusive`. Writes one digest row. Worker polls every 10s.

Every job is durable: surviving restarts, load spikes, and pausing while processing. Duplicate jobs after completion requeue (exclusive policy), so handlers must be idempotent.

### Connection management (`lib/queue/connection.ts`)
Opens a pool to either `pipeline_worker` or `pipeline_intake` with TLS verification against Supabase's CA certificate.

- Reads the CA certificate once from `certs/supabase-ca.crt` (Project Settings → Database → SSL Configuration)
- Scrubs SSL parameters from the URL (node-postgres' `sslmode=require` means "system CAs", not a pinned cert)
- Local connections (`localhost`, `/socket`) skip TLS
- Reads once and caches for the lifetime of the process

### Website queue integration (`lib/queue/intake.ts`)
The app's only queue interface. Connects as `pipeline_intake` with minimal permissions (add jobs, write schedules).

```typescript
export async function enqueue<N extends JobName>(
  name: N,
  data: JobData[N],
  options?: SendOptions,
): Promise<string | null>  // null if policy ignored as duplicate

export async function setSchedule<N extends JobName>(
  name: N,
  key: string,
  cron: string,
  data: JobData[N],
  options?: SendOptions,
): Promise<void>

export async function clearSchedule(name: JobName, key: string): Promise<void>
```

Caches pg-boss on `globalThis` so dev-server reloads reuse the same pool. Never runs migrations or subscribes to jobs.

### Worker lifecycle (`worker/`)
Five modules that compose into `startWorker()`:

**`worker/log.ts`** — Structured JSON output (one line per event) so Railway can search on `event`.

**`worker/pipeline-state.ts`** — One heartbeat query that both:
1. Updates `pipeline_state.heartbeat_at` (liveness signal for Railway)
2. Reads `pipeline_state.mode` (live or paused)

**`worker/queue.ts`** — Starts pg-boss with write permissions for the worker:
- Installs and upgrades the schema (`migrate: true`)
- Creates every job queue
- Grants `pipeline_intake` just enough to add jobs and write schedules

**`worker/worker.ts`** — The core state machine:
- Reads mode every 60s (configurable for tests: 250ms)
- Subscribes handlers when mode is `live`
- Unsubscribes when mode is `paused` (after running jobs finish)
- Stops gracefully on SIGTERM/SIGINT, with a 30s timeout for in-flight work

**`worker/index.ts`** — Entry point (`npm run start:worker`). Loads handlers and manages shutdown.

## Configuration

### Environment variables (added to `.env.local.example`)

```
PIPELINE_WORKER_DATABASE_URL=postgresql://pipeline_worker.<ref>:<pwd>@pooler:5432/postgres
PIPELINE_INTAKE_DATABASE_URL=postgresql://pipeline_intake.<ref>:<pwd>@pooler:5432/postgres
```

Both connect through the session pooler (port 5432). Use the role name as the user, with the project ref appended. TLS is verified in code against `certs/supabase-ca.crt`.

### package.json updates

- Node engine pinned to `>=22.12.0` (pg-boss 12 requirement)
- Added scripts:
  - `dev:worker` — run the worker with hot reload (`tsx watch`)
  - `start:worker` — production worker entry point
  - `test:queue` — integration tests against local Postgres
- Added dependencies:
  - `pg-boss@^12.31.1` (job queue)
  - `pg@^8.23.0` (database client)
  - `tsx@^4` (TypeScript runner for worker scripts)

## Testing

### Queue integration tests (`test/queue/worker.integration.test.ts`)

Three scenarios, running against a real Postgres shaped like a new Supabase project:

1. **Queue creation and restarts** — pg-boss installs cleanly, can restart without errors, and creates all four job queues with their correct policies.

2. **Website permissions** — the website can add jobs and write schedules; it is blocked from creating queues and reading app tables (alerts, competitor_products).

3. **Mode switching and job delivery** — jobs are held while paused, delivered once live, and held again when paused back. Heartbeat stays fresh. Singleton deduplication works.

### Running the tests

```bash
npm run test:queue
```

Requires PostgreSQL 16+ binaries on PATH (`brew install postgresql@16`) and Node 22.

**What it does:**
1. Builds a throwaway local Postgres cluster with Supabase roles (anon, authenticated, service_role) and default grants
2. Runs `supabase/00 → 07` in order
3. Sets `QUEUE_TEST_WORKER_URL`, `QUEUE_TEST_INTAKE_URL`, `QUEUE_TEST_ADMIN_URL`
4. Runs `npx vitest run test/queue`
5. Tears down the cluster and temp socket directory

**Test isolation:**
- Database is rebuilt from scratch each run (see `scripts/test-queue.sh`)
- Socket is `/tmp/competeiq-pg` (105-byte path limit workaround)
- Port is `54329` (high and static to avoid collisions)
- `LC_ALL=C` for predictable locale (psql is picky)

## What's next

Handlers are empty. As each job is built (step 4 onward), a handler is added to `HANDLERS` in `worker/index.ts`:

```typescript
const HANDLERS: JobHandlers = {
  process_apify_run: async (jobs) => {
    // Detailed in spec slice 4
  },
  generate_digest: async (jobs) => {
    // Detailed in spec slice 5
  },
  // etc.
};
```

A queue with no handler keeps jobs until one exists. The worker continues running while handlers are built.

## Files created

```
lib/queue/
  jobs.ts            Job definitions and queue policies
  connection.ts      TLS-verified connection pool
  intake.ts          Website queue interface

worker/
  log.ts             Structured JSON logging
  pipeline-state.ts  Heartbeat + mode read
  queue.ts           pg-boss startup and intake grants
  worker.ts          Core state machine (live/paused)
  index.ts           Entry point

test/queue/
  worker.integration.test.ts   Real database tests

scripts/
  test-queue.sh      Postgres setup and test runner

docs/
  step-3-worker-foundation.md   This document
```

Also updated:
- `package.json` (scripts, dependencies, Node engine)
- `.env.local.example` (pipeline URLs, CA certificate note)
- `CLAUDE.md` (links to runner docs)
- `vitest.config.mts` (server-only alias for tests outside Next)

## Debugging tips

**Queue tests skip if no database URLs** — if you see "⊘ worker queue" at test output, export the URLs manually or check that `scripts/test-queue.sh` ran without error.

**CA certificate missing** — the connection modules will fail clearly: `Missing certs/supabase-ca.crt`. Download from Supabase: Project Settings → Database → SSL Configuration.

**Local dev with real database** — once `.env.local` has both pipeline URLs and the CA certificate, run:
```bash
npm run dev      # web service on :3000
npm run dev:worker   # worker in another terminal
```

Logs from both are JSON, searchable on `event` field.

**Inspecting the test database** — `scripts/test-queue.sh` keeps the Postgres cluster alive until the tests finish. While tests run, connect with:
```bash
psql -h /tmp/competeiq-pg -p 54329 -U super -d app
```

The cluster's log is at `/tmp/competeiq-queue-test.log`.

## Integration with Railway

Worker service:
- Docker image: Node 22 Alpine
- Start command: `npm run start:worker`
- Environment:
  - `PIPELINE_WORKER_DATABASE_URL` (connection string)
  - `NODE_ENV=production`
- Logs: JSON (one line per event), searchable by `event` field

Web service keeps running as is; it just reads `PIPELINE_INTAKE_DATABASE_URL` from the same Supabase instance.
