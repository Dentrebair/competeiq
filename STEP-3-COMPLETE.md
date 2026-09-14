# Step 3: Worker Foundation — Complete

**Date:** 2026-09-14  
**Status:** ✅ All modules built and tested. Ready for step 4.

## Summary

Step 3 implements the worker's foundation: a job queue abstraction, TLS-secured database connections, a health-check heartbeat, graceful mode switching (live/paused), and an integration test harness against a real Postgres instance shaped like a new Supabase project.

The worker skeleton runs immediately on startup and is ready to accept handlers as each job is implemented. Handlers are stubbed; add them to `HANDLERS` in `worker/index.ts` as step 4, 5, and beyond are built.

---

## What was built

### Queue infrastructure (`lib/queue/`)

**`jobs.ts` — Job type system and queue policies**

Centralized definitions for all four job types with their queue policies (short vs exclusive), retry/expiry settings, and polling intervals. Every handler will reference this.

```typescript
export interface JobData {
  start_scrape: { competitorId: string };
  check_apify_run: { runId: string; competitorId: string };
  process_apify_run: { runId: string };
  generate_digest: { digestId: string };
}

export const JOBS = {
  start_scrape: {
    queue: { policy: "short", retryLimit: 2, ... },
    work: { batchSize: 1, pollingIntervalSeconds: 10 },
  },
  // ... etc
}
```

**`connection.ts` — Database connection with TLS verification**

Opens a Pool to either `pipeline_worker` or `pipeline_intake` with:
- SSL verification against Supabase's CA certificate (from `certs/supabase-ca.crt`)
- URL-based SSL params scrubbed (node-postgres' `sslmode=require` bypasses cert pinning)
- Local connections (`localhost`, socket paths) skip TLS
- One-time CA read and cache

Used by both the worker and the website's queue layer.

**`intake.ts` — Website queue interface**

The app's only entry point to the queue. Connects as `pipeline_intake`, which can:
- Add jobs (to any job type)
- Write schedules (create/update/delete cron jobs)
- Cannot create queues, cannot read app tables

Caches pg-boss on `globalThis` so dev-server hot reloads reuse the same pool instead of leaking connections.

```typescript
export async function enqueue<N extends JobName>(
  name: N,
  data: JobData[N],
  options?: SendOptions,
): Promise<string | null>  // null if policy collapsed duplicate
```

### Worker lifecycle (`worker/`)

**`log.ts` — Structured JSON logging**

Every event is one JSON line, queryable by `event` field. Used by Railway's log search and local debugging.

```typescript
log("pipeline_live", { mode: "live", handlers: ["process_apify_run"] });
logError("heartbeat_failed", error, { attempt: 2 });
```

**`pipeline-state.ts` — Heartbeat + mode read**

One atomic query that updates `pipeline_state.heartbeat_at` (liveness signal for Railway) and reads `pipeline_state.mode` (live or paused). Runs every 60 seconds (configurable for tests).

```typescript
export async function heartbeat(db: Pool): Promise<PipelineMode> {
  const { rows } = await db.query(
    "update public.pipeline_state set heartbeat_at = now() returning mode",
  );
  return rows[0].mode;
}
```

**`queue.ts` — pg-boss initialization**

Starts pg-boss as the owner of the `pgboss` schema:
- Installs and upgrades the schema (no schema creation, since 07 created it already)
- Creates every job queue from the `JOBS` definition
- Grants `pipeline_intake` exactly what it needs: select on system tables, insert/update/delete on schedule, insert on job tables

The grants are safe to repeat on every worker start.

**`worker.ts` — Core state machine**

Reads mode every 60s and switches handlers on/off:
- **Mode = live:** Subscribe handlers to their jobs. Workers poll for new jobs and run them.
- **Mode = paused:** Unsubscribe handlers (after running jobs finish). New jobs still arrive; handlers sit idle.

Gracefully stops on SIGTERM/SIGINT, waiting up to 30s for in-flight work.

```typescript
export async function startWorker({
  databaseUrl,
  handlers,
  heartbeatMs = HEARTBEAT_MS,
}: WorkerOptions): Promise<RunningWorker>
```

Returns `{ mode(): PipelineMode | null, stop(): Promise<void> }`.

**`index.ts` — Entry point**

Loads `HANDLERS` from the same file, starts the worker, and sets up SIGTERM/SIGINT handlers for graceful shutdown.

```bash
npm run start:worker    # production
npm run dev:worker      # development with hot reload (tsx watch)
```

### Integration tests (`test/queue/`)

**`worker.integration.test.ts` — Three scenarios**

1. **Queue creation and restarts:** pg-boss installs cleanly, can restart without errors, creates all four job queues.

2. **Website permissions:** Website can add jobs and write schedules; blocked from creating queues and reading app tables.

3. **Mode switching and delivery:** Jobs held while paused, delivered when live, re-held when paused again. Heartbeat stays fresh. Singleton deduplication works (two identical jobs collapse to one; late duplicates after completion requeue).

**`scripts/test-queue.sh` — Test database setup**

Builds a throwaway Postgres cluster with Supabase roles and grants, runs `supabase/00 → 07`, sets environment variables, runs vitest, then tears down.

Requires PostgreSQL 16+ binaries on PATH and Node 22.

---

## Configuration & setup

### Environment variables

Added to `.env.local.example`:

```
PIPELINE_WORKER_DATABASE_URL=postgresql://pipeline_worker.<project-ref>:<pwd>@<pooler>:5432/postgres
PIPELINE_INTAKE_DATABASE_URL=postgresql://pipeline_intake.<project-ref>:<pwd>@<pooler>:5432/postgres
```

Both use the session pooler. Passwords were set manually in step 2 (`alter role pipeline_worker with password '...'`).

No SSL parameters in the URL; TLS is configured in code and verified against `certs/supabase-ca.crt`.

### Package.json updates

**Scripts:**
- `dev:worker` — hot-reload worker (tsx watch)
- `start:worker` — production worker entry point
- `test:queue` — integration tests

**Dependencies:**
- `pg-boss@^12.31.1` (job queue; requires Node 22.12+)
- `pg@^8.23.0` (database client)
- `tsx@^4` (TypeScript runner; already in devDependencies)

**Node engine:**
- `>=22.12.0` (pg-boss 12 requires it)

---

## How to use

### Before running anything

1. **Download CA certificate** from Supabase: Project Settings → Database → SSL Configuration. Save as `certs/supabase-ca.crt`.

2. **Fill in `.env.local`** with the pipeline URLs and passwords (from the password manager, set in step 2).

### Run integration tests

```bash
npm run test:queue
```

Builds a test database from scratch in ~10 seconds. Requires PostgreSQL 16+ and Node 22.

Expected output:
```
✓ worker queue
  ✓ installs the queue and restarts cleanly (60s timeout)
  ✓ lets the website add jobs and write schedules, and nothing else (60s timeout)
  ✓ holds jobs while paused, runs them once live, and stops again when paused (90s timeout)
```

### Run locally (before Railway)

```bash
# Terminal 1
npm run dev

# Terminal 2
npm run dev:worker
```

Both log JSON to stdout. Web service on :3000; worker logs include `event: "pipeline_live"` when mode switches to live.

---

## What's ready for step 4+

### Handlers are empty

`HANDLERS` in `worker/index.ts` is currently `{}`. No jobs run; they queue up and wait.

As each job is implemented, add its handler:

```typescript
import { processApifyRun } from "./handlers/process-apify-run";

const HANDLERS: JobHandlers = {
  process_apify_run: processApifyRun,
  // add more as they're built
};
```

The worker picks up new handlers on next start or hot reload.

### Handler signature

```typescript
export async function myHandler(
  jobs: Job<JobData['job_name']>[]
): Promise<void> {
  for (const job of jobs) {
    // Process job.data
  }
}
```

All jobs in the array have the same type. If any throw, the batch fails and pg-boss retries. For safety, handlers should be idempotent (safe to run twice).

### Where to build

- **Job implementations:** `worker/handlers/` (create modules as needed)
- **Job logic:** `lib/pipeline/` (reference: WF-02 ported to TypeScript in step 2)
- **Tests:** `test/pipeline/` (new) and `test/queue/` (existing integration harness)

### Job lifecycle

- **Singleton keys** prevent duplicates while queued. `short` policy collapses them; `exclusive` policy allows one waiting or running.
- **Late duplicates requeue.** After a job finishes, a second identical job re-enqueues and runs again. Handlers must be idempotent.
- **Pausing holds work.** Jobs keep arriving; handlers unsubscribe so they don't run until mode switches back to `live`.
- **Heartbeat every 60s.** Railway can detect a hung worker by checking `pipeline_state.heartbeat_at`.

---

## Files created (9)

```
lib/queue/
  jobs.ts               (230 lines) Job definitions and policies
  connection.ts         (69 lines) TLS-verified database connection
  intake.ts             (82 lines) Website queue interface

worker/
  index.ts              (44 lines) Entry point
  log.ts                (18 lines) Structured JSON logging
  pipeline-state.ts     (21 lines) Heartbeat + mode read
  queue.ts              (65 lines) pg-boss startup and grants
  worker.ts             (83 lines) Core state machine

test/queue/
  worker.integration.test.ts (120 lines) Three scenarios

scripts/
  test-queue.sh         (65 lines) Test database builder

docs/
  step-3-worker-foundation.md (detailed docs)
```

## Files updated (4)

```
package.json            Node engine, scripts, dependencies
.env.local.example      Pipeline URLs and CA certificate note
CLAUDE.md               Current status and worker setup instructions
vitest.config.mts       server-only alias for tests outside Next
```

---

## Build verification

```bash
$ npm run build
✓ Compiled successfully

$ npx tsc --noEmit
(no errors)

$ npm run test:queue
✓ worker queue
✓ installs the queue and restarts cleanly
✓ lets the website add jobs and write schedules, and nothing else
✓ holds jobs while paused, runs them once live, and stops again when paused
```

---

## Next: Step 4 (process_apify_run)

See `docs/step-4-ready.md` for the ready-to-build checklist. The handler will:

1. Fetch the finished Apify run and the previous baseline
2. Run signal evaluation (ported from WF-02)
3. Write alerts, baseline, baseline_history, and update digests
4. Be idempotent (safe to requeue)

---

## Debugging

**Handler fails silently**
→ Check logs for `event: "queue_error"` or inspect the job in SQL:
```sql
select * from pgboss.job where name = 'process_apify_run' order by createdon desc limit 1;
```

**Database connection refused**
→ Verify `.env.local` has correct URLs and `certs/supabase-ca.crt` exists.

**Tests skip**
→ Check `QUEUE_TEST_WORKER_URL` env var is set by `scripts/test-queue.sh`.

**CA certificate error**
→ The error message is explicit: download from Supabase, save as `certs/supabase-ca.crt`.

---

## Integration with Railway

When handlers are complete:

**Web service:** Existing setup (no changes)

**Worker service (new):**
- Docker image: Node 22 Alpine
- Start command: `npm run start:worker`
- Environment:
  - `PIPELINE_WORKER_DATABASE_URL`
  - `NODE_ENV=production` (optional)

Pipeline starts `paused`. Switch to `live` manually:
```sql
update public.pipeline_state set mode = 'live';
```

---

## Done

Step 3 is complete. The worker foundation is locked in place and ready for handlers.

Next task: Step 4, building the `process_apify_run` handler with its integration tests.
