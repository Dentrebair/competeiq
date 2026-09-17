# Scaling gap analysis — the Apify pipeline

Written 2026-09-17, after comparing this repo's `start_scrape` → Apify →
`process_apify_run` pipeline against a reference job-based async design
(independent per-job execution, webhook-driven completion, no batch
blocking).

**Headline finding: the architecture shape is already right.** Every
competitor is already its own independent job (`start_scrape` takes one
`competitorId`), completion is webhook-driven rather than polled, and there
is no "batch" concept anywhere in this system to accidentally let one slow
competitor block another's results. The reference's core principle — *never
make the batch the unit of execution, make each site the unit* — is already
true here by construction, not something to retrofit.

The real gaps are in two categories: **observability** (can we explain after
the fact what happened to one run) and **resource control** (do we bound
what one run is allowed to do). None of them cause a visible problem today
at the free tier's 2-competitor cap — they matter once competitor count or
run volume grows past what's easy to eyeball in Railway logs.

## Gap inventory

| # | Gap | Current state | Why it matters at scale |
|---|-----|----------------|--------------------------|
| 1 | No retry backoff on `start_scrape` | Fixed 300s retry delay (`lib/queue/jobs.ts`) — `process_apify_run`'s queue already has `retryBackoff: true`, this one doesn't | A transient Apify API blip retries at the same fixed interval instead of backing off; harmless at low volume, wasteful at high volume |
| 2 | No `dataset_id` persisted | Fetched transiently in `process-apify-run.ts` (`run.defaultDatasetId`), never stored | Can't answer "which dataset produced these alerts" later without re-hitting Apify's API — a problem once you need to debug an old run or Apify's own retention expires it |
| 3 | No `completed_at` | Only `updated_at`, which also moves on intermediate steps (running→processing) | No clean single "when did this actually finish" column — have to infer it from whichever update happened to be terminal |
| 4 | No `retry_count` persisted | pg-boss tracks this internally and exposes it as `job.retryCount` on every handler invocation — it's just never read or stored | Can't tell from the data whether a successful run took 1 attempt or 3; a failed *start* attempt (before an Apify run id ever exists) leaves zero trace at all, since `recordScrapeRun` only fires after Apify accepts the run |
| 5 | No explicit per-run timeout sent to Apify | `startApifyRun`'s input (`worker/handlers/start-scrape.ts`) sends `domains`, `maxProducts`, `proxyConfiguration` — no `timeoutSecs` | Relies entirely on Apify's platform-default actor timeout; a genuinely hung actor run has no ceiling we control |
| 6 | No concurrency limit across simultaneous Apify runs | None — `start_scrape`'s "short" queue policy dedupes *per competitor*, not globally | **Not an issue today**: `FREE_TIER_MAX_COMPETITORS = 2` makes 2 the hard ceiling on concurrent runs already. Only matters if that cap rises |
| 7 | No explicit `QUEUED` status | A `scrape_runs` row doesn't exist until `recordScrapeRun` fires — i.e., until *after* Apify has already accepted the run | No visibility into "accepted by our queue, not yet started on Apify" — in practice this window is milliseconds (pg-boss picks up jobs on a 10s poll), so low value; also cuts against the "worker owns all writes to scrape_runs" boundary (CLAUDE.md, "Who owns which column") since the app would need to insert the placeholder row itself |

## Recommended implementation order

Ordered by effort-to-value, not urgency — none of these are blocking today.

### 1. Retry backoff (trivial, no schema change)
One line in `lib/queue/jobs.ts`: add `retryBackoff: true` to `start_scrape`'s
queue config, matching `process_apify_run`'s existing pattern.

### 2. `dataset_id` + `completed_at` (one migration, small code change)
```sql
alter table public.scrape_runs
  add column if not exists dataset_id   text,
  add column if not exists completed_at timestamptz;
```
- `process-apify-run.ts` already has `run.defaultDatasetId` in hand when it
  calls `updateScrapeRunStatus` — pass it through to persist it.
- `updateScrapeRunStatus` sets `completed_at = now()` only when the new
  status is `succeeded` or `failed` (never on `processing`), so it stays a
  clean "when did this actually finish" value.

### 3. `retry_count` (small code change, no new plumbing needed)
`job.retryCount` is already on the `Job` object pg-boss hands to
`startScrape`'s handler (verified against `pg-boss`'s own type
definitions) — no new tracking required, just read and persist it:
```sql
alter table public.scrape_runs add column if not exists retry_count int not null default 0;
```
Separately: a `start_scrape` job that fails on *every* retry attempt
(exhausts `retryLimit: 2` before ever reaching `startApifyRun`'s success)
currently leaves no `scrape_runs` row at all for that competitor — worth
deciding whether that should write a placeholder failed row (with a null
`run_id`) so the attempt isn't invisible.

### 4. Apify run timeout (small code change, needs a value decision)
Add `timeoutSecs` to the actor input in `startApifyRun`. Real observed
runtimes are 10-15s (per the Apify console) — a generous ceiling like 300s
(5 min) catches genuine hangs without ever touching a real run.

### 5. Concurrency limit — defer
No action needed while `FREE_TIER_MAX_COMPETITORS` stays at 2. Revisit if
that cap is ever raised; pg-boss supports capping concurrent work via the
`work()` call's options, so the mechanism exists whenever it's needed.

### 6. Explicit `QUEUED` status — not recommended
Would require the app to write directly to `scrape_runs` for the first
time, crossing the "worker owns all writes" boundary this codebase has
otherwise held to deliberately. The window it would make visible (accepted
by pg-boss, not yet started) is on the order of milliseconds today. Low
value relative to the architectural cost — skip unless a real need surfaces
(e.g., queue depth grows large enough that "queued" becomes a meaningfully
long wait).
