# App Intelligence Engine Migration

Status: designed 2026-09-14. n8n undeployed the same day (Apify last ran 2026-08-23), so nothing produces alerts until the worker ships. Slice 1 in progress. Decisions are recorded in ADR-0003 (runtime and queue), ADR-0004 (cutover), ADR-0005 (scrape clock) and ADR-0006 (classification). Treat them as settled.

## Problem Statement

n8n owns Collection Run intake, Signal Evaluation, production Alert writes, Baseline updates, digest generation and Apify configuration. The app is an interface over it. Business logic is split across two systems, failures are invisible, and the pipeline has been wrong several times in ways only a manual read of the workflow JSON caught.

## Solution

Move all of it into this repository as a Railway worker plus the existing Next.js app. Remove n8n, Apify tasks and Apify Schedules, and Google Sheets. Keep Apify (collection), Claude (interpretation) and Supabase (data, auth, Realtime).

The switch is a direct cutover, gated on the ported code reproducing n8n's output from real captured runs.

## User Stories

1. As an operator, I want each competitor scraped at the fastest cadence among its enabled signals, so settings I change take effect without touching Apify.
2. As an operator, I want Run Now to start a scrape immediately.
3. As an operator, I want a finished scrape processed within minutes, even when a completion webhook is lost.
4. As an operator, I want a forged or duplicate webhook to be unable to create Alerts.
5. As an operator, I want the first app-owned run to diff against the existing Baseline, so it reports real changes rather than every product as new.
6. As an operator, I want signal type and severity decided by fixed rules, so identical changes are always graded identically.
7. As an operator, I want a Claude failure to leave me an Unclassified Alert, not a missing one.
8. As an operator, I want an Alert and its Baseline update to commit together, so partial processing cannot corrupt later comparisons.
9. As an operator, I want to reverse one bad run's Baseline changes without losing later runs.
10. As an operator, I want to pause the pipeline without losing queued work.
11. As an operator, I want to see on the Alerts page when the worker has stopped or a competitor missed its scrape.
12. As an operator, I want digests generated outside the HTTP request, with the existing six-hour staleness check and lock.
13. As an operator, I want alerts to keep arriving over Realtime exactly as they do today.

## Implementation Decisions

### Runtime and data access

- **Two Railway services from one repo.** The Next.js web app, and a worker started with `npm run start:worker`. Raise `engines.node` to `>=22.12`.
- **Queue.** pg-boss on the Supabase session pooler (`:5432`) with `useListenNotify` off, behind a single `queue` module.
  - Create the `pgboss` schema once with the pg-boss CLI, then run with `migrate: false`.
- **Worker database access.** Plain `pg` as a scoped `pipeline_worker` role, holding grants on exactly the tables and columns the pipeline reads and writes. No service role key anywhere.
- **Web service.** It enqueues jobs (webhook intake, Run Now, digest request) and updates schedules. It connects as its own `pipeline_intake` role, which can only add jobs and write schedules (Q25). The worker owns the `pgboss` schema, so it grants those rights on each start. The web service keeps writing operator data through the operator's session, under RLS, as today.

### Scraping

- **Scheduling.** One pg-boss schedule per active competitor, with the interval set by the fastest `frequency_hours` among its enabled live signals (`isSignalLive`). Changing a signal setting, pausing a competitor or adding one updates that schedule.
  - Run Now enqueues the same start-scrape job immediately.
- **Starting a run.** The start-scrape job runs the Shopify scraper Actor directly. Its input is built from `competitors.url`.
  - Before writing the input builder, read the Actor and input the current Apify task uses, and one real dataset (global rule: verify third-party endpoints before coding against them).
- **Completion, path one: the webhook.** Each run carries an ad-hoc webhook pointing at `/api/webhooks/apify`.
  - The secret travels in an `x-webhook-secret` header set through `headersTemplate`, never in the URL.
  - The route compares the secret in constant time, reads only `resource.id`, and enqueues `process_apify_run` with `singletonKey` set to the run ID.
  - It responds non-2xx on any failure, so Apify retries.
- **Completion, path two: the delayed check.** A check job about 30 minutes after start. If the run finished, it enqueues the same singleton job. If the run is still going, it checks again later. If the run failed, it writes `signal_configs.last_error`.

### Processing (`process_apify_run`)

1. **Fetch.** Refetch the run and its dataset from the Apify API. Treat an empty dataset from a successful run as an error until proven otherwise.
2. **Diff.** Run the faithful port of WF-02's Diff Price, Diff Catalog and Diff Promo, plus Normalize Alert's severity bands, as pure functions in `lib/`. Keep WF-02's `dedupe_key` format.
3. **Interpret.** Call Claude `claude-haiku-4-5` with the prompt WF-02 runs today, for summary, impact and action only.
   - Transient errors retry with backoff.
   - When retries are exhausted, write the Alert with `ai_available = false`.
4. **Persist.** One transaction:
   - insert the Alerts;
   - update `competitor_products`;
   - insert Baseline History rows (run ID, product, old and new values);
   - set `signal_configs.last_run_at` and clear `last_error`.
5. **Deliver.** Realtime delivers the new Alerts to the browser unchanged, since the publication is on the table, not on the writer.

### Digest

- **Request.** `requestDigest()` keeps the six-hour staleness check and the `digests` lock. Instead of calling n8n, it enqueues `generate_digest` with the digest ID.
- **Generation.** The worker makes the Opus call with WF-03's current prompt, then updates the row `where id = $1 and status = 'generating'`.

### Safety and operations

- **Pipeline Mode.** A `pipeline_state` row set to `live` or `paused`.
  - Paused: schedules start no scrapes and the worker takes no jobs.
  - Webhooks still enqueue, so work resumes when set back to `live`.
- **Heartbeat.** The worker writes `pipeline_state.heartbeat_at` every minute. The Alerts health bar turns red when the heartbeat is more than 5 minutes old, or when a competitor's `last_run_at` is overdue for its cadence.
- **No backup table.** The old Supabase project is gone, and the new one starts with an empty Baseline.
- **Google Sheets logging is dropped.** The database is the audit trail.

## Testing Decisions

- **Runner.** Vitest.
- **Parity with WF-02's own code** (`test/pipeline/signal-evaluation.parity.test.ts`).
  - `test/reference/wf-02-code-nodes.json` vendors the deciding Code nodes verbatim, and `test/reference/wf02-reference.ts` runs them in WF-02's wiring order.
  - Input is a real dataset (`test/fixtures/apify/deathwish-2026-08-23.json`). Scenarios vary the Baseline to drive each branch: first run, price moves around the thresholds, the per-signal cap, added and removed products, no change, and Claude unavailable.
  - The port must match on changes, Claude requests, alert rows and Baseline rows. Each scenario also asserts its branch fired.
- **Empty dataset.** Tested with processing (slice 3), since it is a run-level check before Signal Evaluation.
- **Queue tests.** Run against a local Supabase: duplicate webhook plus delayed check produces one processing; crash mid-job is recovered; paused mode takes no jobs.
- **Route tests.** Webhook route: wrong secret rejected, body fields other than `resource.id` ignored.
- **Claude seam.** Injected, so retry and exhaustion are tested without the API.

## Delivery Slices

1. **Port and parity.** Vitest, the vendored WF-02 reference, and `lib/pipeline/signal-evaluation.ts` passing parity. No infrastructure.
2. **Foundation.** A migration adding `pipeline_worker` with its grants, `pipeline_state`, Baseline History and the backup table. The `pgboss` schema, the `queue` module, and a worker skeleton with heartbeat and pause.
3. **Processing.** `process_apify_run` end to end, the webhook route and the delayed check.
4. **Scheduling.** Per-competitor schedules, Run Now, the settings-change sync, `last_run_at` and `last_error`, and the health bar.
5. **Digest.** The digest job.
6. **Cutover**, following the order in ADR-0004.
7. **Cleanup.** Once the Apify console shows no schedules or tasks:
   - drop `apify_task_id`, `apify_schedule_id` and the delete-order trigger;
   - remove `lib/n8n.ts`, the `N8N_*` env vars and the n8n handoff docs;
   - update `CLAUDE.md`;
   - retire n8n.

## Known WF-02 quirks carried over by the port

These are pinned by parity, marked "WF-02 quirk" in the code, and change only as a deliberate, separate step.

- **Removed products never leave the Baseline.** Baseline rows are upserts of what was scraped, and nothing deletes. A product that disappears is reported as removed on every later run.
- **Duplicate listings count twice.** A product listed twice in one dataset counts twice in `added_count`.
- **A stored price of 0** gives an Infinity delta, which cannot be inserted.

## Out of Scope

- Email delivery through Resend.
- Replacing Apify or Claude as providers.
- Changing the Claude model or prompts. That is a separate step after cutover.
- Signals marked coming soon (website, ads, reviews, newsletter).
- Rewriting historical Alerts or digests.
- Scheduled digest generation. Digests stay operator-triggered.
