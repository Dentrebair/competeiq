## Project: REAL-LEAD

### What it is
Single-client competitor intelligence platform for ecommerce and D2C brands. Monitors competitor websites 24/7 and delivers AI-interpreted alerts when something commercially meaningful changes — price drops, catalog launches, promotions, ad creatives, website changes, newsletter campaigns.

### Stack
- Next.js 16.3.1 (App Router, Turbopack) + React 19.2 + Tailwind CSS v4
- Supabase (PostgreSQL + Auth + Realtime)
- A Railway worker (this repo, `worker/`) plus pg-boss on the Supabase session
  pooler — the orchestration engine. n8n is fully retired; see "n8n retirement" below.
- Apify (data collection — Shopify scraper today; FB Ads Library, Trustpilot,
  Website Change Monitor are still `coming_soon` in `lib/signals.ts`)
- Claude via the Anthropic API. Automated calls (signal interpretation, digests)
  run in the worker — see `docs/n8n-claude-calls.md` for the prompts (ported
  verbatim, still accurate). Operator-facing calls (chat, single-alert analysis)
  run in the app through `lib/anthropic.ts`.
- Resend (email delivery) — out of scope for the pipeline migration; not currently used by anything in this repo.

**Node 22.12+ is required** (pg-boss 12). Use `nvm use 22` before any npm/next command.

### n8n retirement: complete

**n8n was undeployed on 2026-09-14.** Every piece of pipeline logic it used to
own now lives in this repository, in code, gated on parity fixtures and the
Apify console showing no leftover schedules or tasks (both confirmed before
`supabase/10-cutover-remove-apify.sql` ran). `docs/app-intelligence-migration-spec.md`
and ADRs 0003–0006 record the design; don't re-open those decisions.

What replaced what:

| n8n workflow | Replaced by |
|---|---|
| WF-02 (signal processor) | `worker/handlers/process-apify-run.ts` |
| Config Loader | `syncCompetitorSchedule()` in `app/actions/competitors.ts` |
| Manual Trigger (Run Now) | `runCompetitorNow()` in `app/actions/competitors.ts`, wired to the "Run now" button in `components/competitors/monitoring.tsx` |
| WF-03 (digest) | `worker/handlers/generate-digest.ts` |
| Apify Tasks/Schedules | pg-boss schedules, one per active competitor, in `pgboss.schedule` |

`lib/n8n.ts` is deleted. `N8N_WEBHOOK_*` env vars no longer exist anywhere.
Apify tasks and Apify Schedules are no longer used — the worker starts every
scrape itself, on its own pg-boss cron.

### Architecture
The app is the interface layer. The intelligence engine is the worker — this
repo's own code, not an external orchestrator.

```
Worker's own pg-boss cron (per competitor, ADR-0005)
  └─ start_scrape ─> runs the Apify Actor directly
       └─ ACTOR.RUN.SUCCEEDED webhook ─> /api/webhooks/apify ─> enqueue process_apify_run
            └─ diff vs previous Baseline ─> Claude ─> writes alerts + Baseline to Supabase
                                                          │
browser <──── Supabase Realtime (WebSocket) ──────────────┘
  app ──── enqueue (pg-boss insert, as pipeline_intake) ────> worker   (outbound only)
```

**The app never receives data from the worker over HTTP.** The worker writes to
Supabase as the scoped `pipeline_worker` role; the browser learns about it over a
Realtime WebSocket straight to Supabase. Realtime does *not* call into Next.js
route handlers. `/api/webhooks/apify` **is** an inbound HTTP endpoint (ADR-0005
reversed the old "no inbound endpoint" rule) — but it only enqueues a job by run
ID; the worker refetches the run and dataset from Apify itself and never trusts
the webhook body.

### Worker jobs (`lib/queue/jobs.ts`, handlers in `worker/handlers/`)
- `start_scrape` — runs the Shopify scraper Actor for one competitor. Fired by
  that competitor's pg-boss schedule, or by Run Now (`runCompetitorNow()`).
- `check_apify_run` — the delayed backstop (~30 min after start) for a lost
  completion webhook. Polls Apify; on SUCCEEDED enqueues processor, on RUNNING
  reschedules itself for ~5 min, on FAILED/ABORTED logs and skips.
- `process_apify_run` — diffs the run against the Baseline, calls Claude Haiku,
  writes alerts + Baseline in one transaction.
- `generate_digest` — Claude Opus with thinking on, `effort: high`, structured
  output via `jsonSchemaOutputFormat()`. Can run for minutes.

Consequence for the UI, and it is not optional: **login must never block on the
digest.** The page loads the alert feed from Supabase immediately and renders the
digest section in a loading state; Realtime replaces it when the row lands. A
timeout from `requestDigest()` is not meaningful the way it used to be, though —
enqueuing is a direct database insert, not an HTTP round trip, so it either
queues the job or throws; there is no ambiguous "maybe it started" case anymore.

### Two directions between the app and the worker

**Direction 1 — Apify → app → worker.** Apify fires `/api/webhooks/apify` itself
when an Actor run finishes. The route validates `x-webhook-secret` in constant
time, reads only `resource.id`, and enqueues `process_apify_run` — it does not
process anything itself. The worker resolves which competitor the run belongs to
from its own record (`scrape_runs`, supabase/08), never from the webhook body.

**Direction 2 — App → worker, via the queue.** The only way the app reaches the
worker. Four operator situations, all going through `lib/queue/intake.ts`
(`enqueue`/`setSchedule`/`clearSchedule`), which is `server-only`:

| # | Operator does | App does |
|---|---|---|
| 1 | Adds a competitor | `syncCompetitorSchedule()` sets a pg-boss schedule |
| 2 | Changes monitoring frequency | `syncCompetitorSchedule()` updates it |
| 3 | Clicks Run Now on a competitor | `runCompetitorNow()` enqueues `start_scrape` |
| 4 | Logs in with a stale digest (>6h) | `requestDigest()` enqueues `generate_digest` |

1 and 2 share one function — there is no separate endpoint. Run Now acts on a
competitor, not on one of its signals; there is no per-competitor Apify task
anymore, so nothing needs reconciling at that level.

Cadence is **per signal**. `signal_configs` holds a row for each of the seven
signals per competitor (`frequency_hours`, `enabled`), and `syncCompetitorSchedule()`
computes one pg-boss schedule per competitor at the fastest enabled, live
signal's cadence (`lib/scheduling.ts`) — replacing the seven separate Apify
Schedules n8n used to create per competitor. The competitor is still the unit of
"which site"; the signal is still the unit of "how often".

### Database (Supabase)
Run in order; every file is additive and idempotent.

| File | Purpose |
|---|---|
| `00-base-tables.sql` | `competitors`, `alerts`, `competitor_products` as n8n had them. Run first on a new project. |
| `01-app-layer.sql` | RLS, `is_read`/`read_at`, `dedupe_key`, feed indexes, `digests` + lock, realtime publication |
| `02-signal-configs.sql` | `signal_configs` table + backfill of the seven signals per competitor |
| `03-ownership-hardening.sql` | Column grants (app vs n8n), delete-order trigger, conditional `signal_type` CHECK |
| `04-revoke-default-grants.sql` | Removes Supabase's default blanket grants that 03 left in place |
| `05-intelligence-layer.sql` | `brand_profile`, `competitor_suggestions`, `alert_analyses`, `conversations`, `messages`; `alerts.impact`/`confidence` |
| `06-dedupe-key-index-fix.sql` | Makes `alerts.dedupe_key` usable by `ON CONFLICT` |
| `07-pipeline-worker.sql` | `pipeline_worker` / `pipeline_intake` logins, `pgboss` schema, `pipeline_state`, `baseline_history` |
| `08-scrape-runs.sql` | `scrape_runs` — run→competitor lookup so `process_apify_run` never has to trust the webhook body |
| `09-worker-reads-brand-profile.sql` | Grants `pipeline_worker` select on `brand_profile` (needed by `generate_digest`) |
| `10-cutover-remove-apify.sql` | Drops `apify_task_id`, `apify_schedule_id`, and the delete-order trigger — destructive, gated on confirming the Apify console shows no live schedules/tasks first |
| `11-run-progress-and-delete.sql` | Fixes `alerts`/`competitor_products` FKs to `competitors` so a hard delete works; adds `status`/`error`/`updated_at` to `scrape_runs` plus Realtime, so the UI can show "Run Now" progress live |

> **The original Supabase project was deleted** (found 2026-09-14). A new project
> is built by running 00 → 11 in order.

> The Supabase SQL Editor shows **only the last statement's result**. Files with
> several verification queries appear to run only the last one — they don't, but
> you won't see the earlier output. `04` folds every check into one query.

Tables: `competitors`, `alerts`, `competitor_products` (the pipeline's) plus
`digests`, `pipeline_state`, `baseline_history`, `scrape_runs` (added by the migration).

`scrape_runs` is the only worker-owned table the browser can read (11 grants
`authenticated` SELECT + Realtime) — purely so the UI can show "Run Now"
progress (`running` → `processing` → `succeeded`/`failed`). Nothing else
changes: the app still never writes it, and the worker is still the only
writer of every column.

Things that surprise people:
- `alerts.id` is **bigint**, not uuid. `digests.alert_ids` is `bigint[]` to match.
- `alerts.competitor_name` is denormalised — no join needed, and the alert
  survives its competitor being deleted.
- `alerts.severity` and `signal_type` are **free text**, not enums. Use
  `normalizeSeverity()` from `lib/types/database.ts` before styling on severity.
- `alerts.ai_available = false` means the Claude call failed — the alert is
  *unclassified*, not low priority. Never render it as graded.
- `competitor_products` is the pricing diff store (per-product `last_price`).
  RLS on, zero policies for the app's roles: the app cannot read it, by design
  (`pipeline_worker` can — that's the Baseline it diffs against).
- `signal_configs` **does** exist (`02-signal-configs.sql`) and is read by
  `app/competitors/page.tsx`. One row per competitor per signal, holding cadence.
  What is per-competitor rather than per-signal is the pg-boss schedule
  (`lib/scheduling.ts`) and Run Now.

### One signal vocabulary

Seven strings, used everywhere — `signal_configs.signal_type` and
`alerts.signal_type` hold the *same* value. There is no translation between "what
we monitor" and "what happened". Defined once in `lib/signals.ts`:

`sku_price_change` · `catalog_change` · `promo_discount` · `ad_creative` ·
`review_sentiment` · `website_change` · `newsletter`

`lib/signals.ts` deliberately has **no `server-only` marker and no imports** — the
browser feed needs these strings too. Putting them in a server-only module (like
`lib/anthropic.ts`) would drag `server-only` into the client bundle via
`lib/supabase/client.ts` → `lib/types/database.ts`.

### Who owns which column

The app declares **desired** state. The worker reconciles it and writes back
**actual** state. Enforced by column grants in `03-ownership-hardening.sql`, not
by convention:

| Column | Owner | App may write? |
|---|---|---|
| `competitors.name/domain/url/active` | app | yes |
| `signal_configs.frequency_hours/enabled` | app | yes |
| `signal_configs.last_run_at/last_error` | worker | no |
| `alerts.is_read/read_at` | app | yes |
| everything else on `alerts` | worker | no |

`competitors.apify_task_id` and `signal_configs.apify_schedule_id` existed for
this same purpose in the n8n era and are now dropped (`10-cutover-remove-apify.sql`)
— the worker's schedule lives in `pgboss.schedule`, not on these tables at all.

**Deleting a competitor** (`deleteCompetitor()` in `app/actions/competitors.ts`,
wired to a two-click confirm in `components/competitors/monitoring.tsx`) does
the guard the old delete-order trigger used to: `clearSchedule()` first, so a
deleted competitor can't leave its pg-boss cron firing forever against an id
that no longer resolves, then the row delete. `alerts.competitor_id` (`SET
NULL`) and `competitor_products` (`CASCADE`) both had to be fixed in
`11-run-progress-and-delete.sql` first — before that migration, deleting a
competitor with any alert or baseline row failed outright on the default FK
behavior. Soft delete (`setCompetitorActive(id, false)`, pause) is still the
everyday action for "stop watching this for now"; hard delete is for "this
was a mistake" or "gone for good" — alerts survive it (they keep their own
`competitor_name`), everything else the worker owns does not.

### Key rules
- The worker owns all pipeline logic (see "n8n retirement"). The app never processes signals directly — it only enqueues jobs and reads results over Realtime.
- **`lib/dal.ts` is the authorization boundary, not `proxy.ts`.** Every Server
  Component, Route Handler, and Server Action that touches operator data calls
  `requireUser()` first. Proxy does session refresh and an optimistic bounce only.
- Use `getUser()`, never `getSession()`, on the server. `getSession()` trusts the
  cookie without verifying the JWT.
- RLS is enabled on every table and is not optional — the anon key ships to the
  browser. `snapshots` has RLS on with zero policies; the app must never read it.
- The app writes through the operator's own session so RLS stays a live backstop.
  It does **not** hold the service role key.
- Supabase self-signup must stay disabled; the single operator is created by hand.
- Supabase Realtime drives live updates. No polling from the frontend.
- Single-client deployment. No multi-tenancy.

### Next 16 conventions (differ from 14/15 — check before writing code)
Read `node_modules/next/dist/docs/` for anything uncertain; `AGENTS.md` is
auto-generated by `next dev` and says the same.

- `middleware.ts` is deprecated → **`proxy.ts`**, exporting `proxy`. Runs on the
  `nodejs` runtime; not configurable to edge.
- `cookies()`, `headers()`, `params`, `searchParams` are **async** — synchronous
  access was removed, not deprecated.
- `revalidateTag(tag)` now needs a `cacheLife` profile: `revalidateTag(tag, 'max')`.
  Prefer `updateTag()` (read-your-writes) after operator mutations, and
  `refresh()` to refresh the client router from a Server Action.
- `next lint` is removed — run ESLint directly (`eslint.config.mjs`, flat config).
- Turbopack is the default for dev and build; no flags needed.
- `PageProps<"/route">` / `LayoutProps<"/route">` are generated globals. After
  adding a route, run `npx next typegen`.
- `cacheComponents` (PPR) is deliberately **off**. Enabling it is not a rename —
  it surfaces build errors for uncached data outside `<Suspense>`.

### Environment variables
See `.env.local.example`. Only these:

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
ANTHROPIC_API_KEY        # web AND worker both need their own copy — see .env.local.example
APIFY_API_TOKEN          # worker service only
APP_URL                  # worker service only — the WEB app's public URL, not the worker's
APIFY_WEBHOOK_SECRET     # both services — worker sets it, web's webhook route checks it
PIPELINE_WORKER_DATABASE_URL   # worker service only
PIPELINE_INTAKE_DATABASE_URL   # web service only
```

Both pipeline URLs connect through the session pooler, with TLS verified against
`certs/supabase-ca.crt`. Run the worker locally with `npm run dev:worker`, and the
queue tests (local Postgres 16+) with `npm run test:queue`.

### Build status (updated 2026-09-15 — n8n cutover complete, pipeline verified live)

**Foundation (Step 3):** queue abstractions (`lib/queue/jobs.ts`,
`lib/queue/connection.ts` for TLS, `lib/queue/intake.ts` for the website side),
worker lifecycle (`worker/` — log, heartbeat, mode switch, graceful stop),
integration tests (`test/queue/worker.integration.test.ts` +
`scripts/test-queue.sh`). See `docs/step-3-worker-foundation.md`.

Not here on purpose: `SUPABASE_SERVICE_ROLE_KEY` (neither service needs it —
see "Key rules"), `RESEND_API_KEY` (email delivery is out of scope for this
migration).

**Working, verified against a real Apify run:** login, `proxy.ts` auth gate,
alert feed over Realtime, competitor management (add/pause/resume/sync/**delete**
all reconcile a real pg-boss schedule, not a dead webhook call), all four
worker jobs (`start_scrape`, `check_apify_run`, `process_apify_run`,
`generate_digest`), the webhook route (`/api/webhooks/apify`), the
run→competitor lookup (`scrape_runs`), migrations 00→11.

**Confirmed working end-to-end (2026-09-15):** a real competitor
(deathwishcoffee.com) went through the full chain — Run Now → `start_scrape` →
Apify → webhook → `process_apify_run` → alerts written → visible in the
browser over Realtime. A second competitor (zillow.myshopify.com) correctly
produced no alerts because Apify itself rejected it as not a compatible
Shopify store — proof the pipeline distinguishes a real scrape failure from
"nothing changed" rather than silently swallowing it.

**UI, added after the first live test surfaced gaps in visibility:**
- Per-competitor "Run now" button shows live progress (`RunProgress` in
  `components/competitors/monitoring.tsx`, reading `scrape_runs` over
  Realtime) — running → processing → succeeded/failed, not just a click that
  might have done something.
- Pause/resume is a one-click toggle directly on each competitor's card, not
  just inside the detail panel.
- A failing signal's `last_error` expands in place instead of only being
  readable in a hover tooltip.
- Hard delete (`deleteCompetitor()`), two-click confirm, clears the schedule
  before the row delete.
- Structured JSON logs (`console.error`/`log()`) added at every stage of
  `start_scrape` / `check_apify_run` / `process_apify_run` and every app
  action's failure path, specifically so a Railway log search on `event` can
  answer "what did Run Now actually do" without guessing.

**Never verified:** the digest Realtime path specifically — whether a
`digests` UPDATE reaches a real browser tab. The `alerts` half of Realtime
delivery is now confirmed live; digest generation has not been triggered
against a real Claude Opus call outside unit tests yet. See
`docs/WF-03-handoff.md` (written for the n8n era but the underlying Realtime
mechanics are unchanged).

### Decisions made
- **Releasing the digest lock on a failed enqueue is unconditional.**
  `enqueue()` is a direct database insert, not an HTTP round trip — it either
  queues the job or throws. Unlike the old n8n webhook call, there is no
  ambiguous "it may have started" timeout case, so `app/actions/digest.ts`
  always reaps the lock at zero age on failure. Safe for the same reason as
  before: the partial unique index guarantees the one `'generating'` row is the
  one just inserted.
- **The app owns the 6-hour digest staleness check.** `generate_digest` ignores
  any notion of staleness and generates whenever it runs. The app only enqueues
  it when a digest is genuinely due, and the partial unique index on
  `digests.status='generating'` prevents concurrent runs.

### Open
- **Rotate the credentials that were pasted into chat during setup**
  (`PIPELINE_WORKER_DATABASE_URL`/`PIPELINE_INTAKE_DATABASE_URL` passwords,
  `APIFY_API_TOKEN`) — advised during the live-test session, status unconfirmed.
  Rotate via `alter role ... with password '<new>'` for each pipeline role and
  regenerate the Apify token from the Apify Console, then update both
  `.env.local` and the Railway env vars for both services.
- Flip `pipeline_state.mode = 'live'` once satisfied with manual-trigger testing
  (`update public.pipeline_state set mode = 'live';` — no `id` column, it's a
  singleton row) so competitors' own schedules start firing without a manual
  Run Now each time.

### Handoff docs
- `docs/n8n-claude-calls.md` — the Claude prompts and schemas, ported verbatim
  into `lib/pipeline/interpretation-prompt.ts` and `lib/pipeline/digest-prompt.ts`
- `docs/WF-03-handoff.md`, `docs/wiring-app-to-n8n.md` — written for the n8n
  session; historical only, since there is no more n8n session to hand off to

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues; use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo with `CONTEXT.md` and `docs/adr/` at the root. See `docs/agents/domain.md`.
