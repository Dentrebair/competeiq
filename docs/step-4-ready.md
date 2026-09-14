# Step 4 and Beyond — Ready to Start

Step 3 (Worker Foundation) is complete. The queue infrastructure, heartbeat, mode switching, and test harness are all in place. The next phase is adding job handlers one by one.

## Immediate setup (before running anything)

### 1. Download the CA certificate

Supabase → Project Settings → Database → SSL Configuration

Save as `certs/supabase-ca.crt` in the project root.

### 2. Fill in `.env.local`

Copy from `.env.local.example`. Set:

```
PIPELINE_WORKER_DATABASE_URL=postgresql://pipeline_worker.<project-ref>:<password>@<pooler-host>:5432/postgres
PIPELINE_INTAKE_DATABASE_URL=postgresql://pipeline_intake.<project-ref>:<password>@<pooler-host>:5432/postgres
```

Get the role passwords from the password manager (set in step 2, when you ran `alter role pipeline_worker with password '...'`).

### 3. Verify with tests

```bash
npm run test:queue
```

Requires PostgreSQL 16+ and builds a test database from scratch. Should take ~10s.

Expected output:
```
✓ worker queue
  ✓ installs the queue and restarts cleanly
  ✓ lets the website add jobs and write schedules, and nothing else
  ✓ holds jobs while paused, runs them once live, and stops again when paused
```

## Running locally (before Railway)

```bash
# Terminal 1: web service
npm run dev

# Terminal 2: worker service (separate terminal, same process)
npm run dev:worker
```

Both log JSON to stdout. Worker logs include `event: "pipeline_live"` once mode switches.

## What comes next

Job handlers are built in delivery slices, starting with **slice 4: process_apify_run** (turn finished Apify runs into alerts and baseline).

### Adding a handler

1. Implement the handler function in a new module (e.g., `worker/handlers/process-apify-run.ts`)
2. Import it and add to `HANDLERS` in `worker/index.ts`:

```typescript
import { processApifyRun } from "./handlers/process-apify-run";

const HANDLERS: JobHandlers = {
  process_apify_run: processApifyRun,
  // add more as they're built
};
```

3. The worker picks it up on next start (or hot reload during `npm run dev:worker`)

### Handler signature

```typescript
export async function processApifyRun(jobs: Job<JobData['process_apify_run']>[]): Promise<void> {
  for (const job of jobs) {
    const { runId } = job.data;
    // Do the work
  }
}
```

Handlers receive an array (batch size is 1 by default, but batches are possible). They run sequentially within a job. If any throw, the entire batch fails and pg-boss retries.

## Job lifecycle reminders

- **Singleton keys** prevent duplicate jobs in a queue. `start_scrape` uses `short` policy (at most one waiting). `process_apify_run`, `check_apify_run`, `generate_digest` use `exclusive` (one waiting or running).
- **Late duplicates after completion requeue.** A webhook arriving after the job finished re-enqueues it. Handlers must be idempotent (safe to run twice for the same run ID).
- **Pausing holds work.** While `pipeline_state.mode = 'paused'`, handlers unsubscribe. Jobs keep arriving; they run when mode switches back to `live`.
- **Heartbeat every 60s.** Worker updates `pipeline_state.heartbeat_at`. Railway or a manual health check can use this to detect a hung worker.

## Where specs live

- **Job definitions and policies:** `lib/queue/jobs.ts` (do not edit)
- **Queue abstractions:** `lib/queue/` (do not edit — these are the integration layer)
- **Baseline History, Parity, Signal Evaluation:** `lib/pipeline/` (reference for handlers)
- **Worker framework:** `worker/` (add handler modules, don't edit the core)
- **Tests:** `test/queue/` + `test/pipeline/` (add tests as handlers are built)

## Debugging

**Handler dies silently** → check the json logs for `event: "queue_error"` or job status in SQL:

```sql
select * from pgboss.job where name = 'process_apify_run' order by createdon desc limit 1;
```

Inspect the payload in the `data` column to see what the job tried to process.

**Database connection refused** → check `.env.local` has correct URLs and `certs/supabase-ca.crt` exists.

**Tests skip with "⊘ worker queue"** → make sure `.env.local` is not in `.gitignore` locally, and `scripts/test-queue.sh` ran without error.

## Integration with Railway

When handlers are complete, deploy as:
- Web service: existing setup (no changes)
- Worker service: new, pointing at `npm run start:worker`

Both need the same Supabase project. Worker gets `PIPELINE_WORKER_DATABASE_URL`; web gets `PIPELINE_INTAKE_DATABASE_URL`. Both can read from the other's tables (that is intentional for testing and debugging).

Pipeline starts `paused` by default. Switch to `live` manually in the SQL editor:

```sql
update public.pipeline_state set mode = 'live';
```

## Files ready to edit

Add handlers here:
- `worker/handlers/` (create as needed)

Implement job logic here:
- `lib/pipeline/` (reference: WF-02 ported to TypeScript)

Add tests here:
- `test/pipeline/` (parity fixtures, unit tests)
- `test/queue/` (existing: integration harness)

## Done

Step 3 is locked in. Ready to build step 4: process_apify_run handler and its tests.
