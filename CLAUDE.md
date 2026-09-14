## Project: REAL-LEAD

### What it is
Single-client competitor intelligence platform for ecommerce and D2C brands. Monitors competitor websites 24/7 and delivers AI-interpreted alerts when something commercially meaningful changes — price drops, catalog launches, promotions, ad creatives, website changes, newsletter campaigns.

### Stack
- Next.js 16.3.1 (App Router, Turbopack) + React 19.2 + Tailwind CSS v4
- Supabase (PostgreSQL + Auth + Realtime)
- n8n self-hosted at n8n.srv1816291.hstgr.cloud (orchestration engine)
- Apify (data collection — Shopify scraper, FB Ads Library, Trustpilot, Website Change Monitor)
- Claude via the Anthropic API. Automated calls (signal interpretation, digests) run in n8n — see `docs/n8n-claude-calls.md`. Operator-facing calls (chat, single-alert analysis) run in the app through `lib/anthropic.ts`.
- Google Sheets (alert output and digest logging)
- Resend (email delivery, sent from n8n)

**Node 20.9+ is required** by Next 16. The shell default here is Node 16, which
fails outright. Use `nvm use 22` before any npm/next command.

### Migration away from n8n: in progress

**n8n was undeployed on 2026-09-14, and Apify last ran on 2026-08-23.** Until the
worker ships, nothing produces alerts or digests. Config Loader, Run Now and the
digest request fail soft.

The sections below describe the n8n-era system. Its data model and security rules
still hold. Its n8n plumbing is being replaced. Read
`docs/app-intelligence-migration-spec.md` and ADRs 0003–0006 before any pipeline,
queue, scraping, digest-generation or deployment work. Don't re-open those
decisions.

In short:
- a Railway worker plus pg-boss on the Supabase session pooler, connecting as a
  scoped `pipeline_worker` role;
- the worker owns the scrape clock, with no Apify tasks or schedules;
- `/api/webhooks/apify` plus a delayed check;
- deterministic signal type and severity, with Claude Haiku writing the words;
- a direct cutover gated on parity fixtures.

Rules in this file that flip **at cutover, not before**:
- "n8n owns all pipeline logic";
- "no inbound endpoint";
- the Config Loader, Manual Trigger and Digest webhooks;
- the `apify_task_id` / `apify_schedule_id` column ownership and the delete-order trigger;
- Google Sheets output;
- Node 20.9+ becomes Node 22.12+ (pg-boss 12).

### Architecture
The app is the interface layer only. The intelligence engine lives in n8n.

```
Apify (scheduled scrape)
  └─ ACTOR.RUN.SUCCEEDED webhook ─> n8n WF-02
       └─ diff vs previous snapshot ─> Claude ─> writes alerts to Supabase + Sheets
                                                    │
browser <──── Supabase Realtime (WebSocket) ────────┘
  app ──── POST + x-webhook-secret ────> n8n   (outbound only)
```

**The app never receives data from n8n over HTTP.** n8n writes to Supabase with
the service role; the browser learns about it over a Realtime WebSocket straight
to Supabase. Realtime does *not* call into Next.js route handlers — there is no
inbound ingest endpoint, and adding one would break the property that alerts keep
landing while the app is down or mid-deploy. WF-02 also has to *read* the previous
snapshot to compute its diff, which is a second reason it talks to Supabase
directly.

### n8n Workflows (already built)
- WF-01: Manual test pipeline (dev use only)
- WF-02: Production signal processor (webhook-driven, always running) — `claude-haiku-4-5`
- WF-03: Digest generator (triggered on-demand by app, not cron) — `claude-opus-5`

**WF-03's Webhook node must be set to Response Mode: Immediately**, with a
"Respond to Webhook" node returning `202 Accepted` placed *before* any other
processing. Opus 5 with thinking on runs for minutes; the workflow continues in
the background, writes the finished digest to `digests`, and the app picks it up
over Realtime.

Consequence for the UI, and it is not optional: **login must never block on the
digest.** The page loads the alert feed from Supabase immediately and renders the
digest section in a loading state; Realtime replaces it when the row lands. A
timeout from `triggerDigest()` is therefore not necessarily a failure — the run
may still be in progress.

### Two webhook directions — do not conflate them

**Direction 1 — Apify → n8n.** Apify fires this itself when an actor run
finishes; it is the Webhook trigger node in WF-02. **The app has no part in it.**
There is no inbound endpoint in this codebase and there should never be one: WF-02
writes to Supabase and the browser learns about it over Realtime, which is what
keeps alerts landing while the app is down or mid-deploy.

**Direction 2 — App → n8n.** The only way the app talks to n8n. Four operator
situations, three endpoints:

| # | Operator does | Endpoint | n8n does |
|---|---|---|---|
| 1 | Adds a competitor | Config Loader | Creates the Apify schedule for that competitor |
| 2 | Changes monitoring frequency | Config Loader | Updates that competitor's Apify schedule |
| 3 | Clicks Run Now on a competitor | Manual Trigger | Runs the Apify actor immediately |
| 4 | Logs in with a stale digest (>6h) | Digest | Runs WF-03 |

1 and 2 share one endpoint — there is no fourth webhook. All three go through
`lib/n8n.ts`, which is `server-only`, so importing it into a Client Component is
a build error rather than a leaked secret.

Config is **per competitor** at the Apify level: one Apify task per competitor
(`competitors.apify_task_id`), and Run Now acts on a competitor — not on one of
its signals.

Cadence, though, is **per signal**. `signal_configs` holds a row for each of the
seven signals per competitor (`frequency_hours`, `enabled`), and n8n writes back
the `apify_schedule_id` it gets from the Apify Schedules API. So the Config
Loader payload always carries all seven, and the competitor is the unit of
"which site", while the signal is the unit of "how often".

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

> **The original Supabase project was deleted** (found 2026-09-14). A new project
> is built by running 00 → 07 in order.

> The Supabase SQL Editor shows **only the last statement's result**. Files with
> several verification queries appear to run only the last one — they don't, but
> you won't see the earlier output. `04` folds every check into one query.

Tables: `competitors`, `alerts`, `competitor_products` (n8n's) plus `digests`
(added by the migration).

Things that surprise people:
- `alerts.id` is **bigint**, not uuid. `digests.alert_ids` is `bigint[]` to match.
- `alerts.competitor_name` is denormalised — no join needed, and the alert
  survives its competitor being deleted.
- `alerts.severity` and `signal_type` are **free text**, not enums. Use
  `normalizeSeverity()` from `lib/types/database.ts` before styling on severity.
- `alerts.ai_available = false` means the Claude call failed — the alert is
  *unclassified*, not low priority. Never render it as graded.
- `competitor_products` is the pricing diff store (per-product `last_price`).
  RLS on, zero policies: the app cannot read it, by design.
- `signal_configs` **does** exist (`02-signal-configs.sql`) and is read by
  `app/competitors/page.tsx`. Earlier drafts of this file said otherwise; that
  was wrong. One row per competitor per signal, holding cadence and n8n's
  `apify_schedule_id`. What is per-competitor rather than per-signal is the
  Apify *task* (`competitors.apify_task_id`) and Run Now.

### One signal vocabulary

Seven strings, used everywhere — `signal_configs.signal_type` and
`alerts.signal_type` hold the *same* value. There is no translation between "what
we monitor" and "what happened". Defined once in `lib/signals.ts`:

`sku_price_change` · `catalog_change` · `promo_discount` · `ad_creative` ·
`review_sentiment` · `website_change` · `newsletter`

`lib/signals.ts` deliberately has **no `server-only` marker and no imports** — the
browser feed needs these strings too. Putting them in `lib/n8n.ts` (which is
server-only) drags `server-only` into the client bundle via
`lib/supabase/client.ts` → `lib/types/database.ts`.

### Who owns which column

The app declares **desired** state. n8n reconciles it with Apify and writes back
**actual** state. Enforced by column grants in `03-ownership-hardening.sql`, not
by convention:

| Column | Owner | App may write? |
|---|---|---|
| `competitors.name/domain/url/active` | app | yes |
| `competitors.apify_task_id` | n8n | no |
| `signal_configs.frequency_hours/enabled` | app | yes |
| `signal_configs.apify_schedule_id` | n8n | no |
| `signal_configs.last_run_at/last_error` | n8n | no |
| `alerts.is_read/read_at` | app | yes |
| everything else on `alerts` | n8n | no |

n8n populates `apify_schedule_id` after calling the Apify Schedules API, so that
when a signal is disabled or a competitor removed it knows which schedule to
cancel without interrogating Apify.

> **Deleting a competitor has an order dependency.** `signal_configs` cascades on
> delete, so removing a competitor destroys every `apify_schedule_id` in the same
> statement — and any still-live Apify schedule keeps running, keeps scraping and
> keeps billing with nothing referencing it. A trigger blocks the delete while a
> live schedule exists. Correct teardown: set `active = false` → call n8n to
> cancel → n8n NULLs `apify_schedule_id` → delete. Prefer soft delete.

### Key rules
- n8n owns all pipeline logic until cutover (see "Migration away from n8n"). The app never processes signals directly.
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
N8N_WEBHOOK_SECRET
N8N_WEBHOOK_CONFIG_LOADER
N8N_WEBHOOK_MANUAL_TRIGGER
N8N_WEBHOOK_DIGEST
ANTHROPIC_API_KEY   # chat and single-alert analysis only; blank = those report unavailable
PIPELINE_WORKER_DATABASE_URL   # worker service only
PIPELINE_INTAKE_DATABASE_URL   # web service only
```

Both pipeline URLs connect through the session pooler, with TLS verified against
`certs/supabase-ca.crt`. Run the worker locally with `npm run dev:worker`, and the
queue tests (local Postgres 16+) with `npm run test:queue`.

### Build status (updated 2026-09-14)

**Step 3 complete (Worker Foundation):**
- Queue abstractions: `lib/queue/jobs.ts` (definitions), `lib/queue/connection.ts` (TLS),
  `lib/queue/intake.ts` (website API)
- Worker lifecycle: `worker/` (log, heartbeat, mode switch, graceful stop)
- Integration tests: `test/queue/worker.integration.test.ts` + `scripts/test-queue.sh`
- Node engine updated to >=22.12.0 (pg-boss requirement)
- See `docs/step-3-worker-foundation.md` for full details

Handlers are empty (`HANDLERS` in `worker/index.ts`). Add them as each job is
implemented (step 4 onward). The worker runs while handlers are built.

Not here on purpose: `SUPABASE_SERVICE_ROLE_KEY` (n8n holds it),
`RESEND_API_KEY` (called from n8n),
`N8N_WEBHOOK_SIGNAL_PROCESSOR` (no such call — Apify triggers WF-02).

### Build status (last updated 2026-08-18)

**Working and verified in a browser:** login, `proxy.ts` auth gate (`/` → 307 →
`/login`), alert feed reading real rows from Supabase, competitor management
showing Death Wish Coffee with its 7 signals. Migrations 01–04 all applied.
Anon key confirmed locked out of all five tables (`42501` on every one).

**Built but unusable until n8n exists:** the three webhook calls in `lib/n8n.ts`.
`.env.local` has the Supabase values filled and all `N8N_WEBHOOK_*` blank, so the
app fails soft — competitors save and warn that n8n is unconfigured.

**Built, awaiting WF-03:** the digest view — `components/digest-panel.tsx` on the
dashboard, `app/actions/digest.ts`, `lib/digest.ts`. It renders whatever is in
`digests` and subscribes for UPDATE, so it lights up the moment WF-03 PATCHes a
row. With `N8N_WEBHOOK_DIGEST` blank it fails soft: it takes the lock, the webhook
call fails as a configuration error, the lock is released immediately, and the
panel says n8n is unreachable rather than spinning.

The panel fires `requestDigest()` from a mount effect, never from the page's
Server Component — that is what keeps login off the digest's critical path.

**Never verified:** the Realtime smoke test. See `docs/WF-03-handoff.md`. The
digest panel now depends on it: `digests` UPDATE is the only way a finished
briefing reaches the browser.

### Decisions made
- **Releasing the digest lock on a failed webhook call is conditional.** A 4xx/5xx
  or a missing env var means n8n definitively did not take the job, so
  `app/actions/digest.ts` reaps the lock at zero age — safe only because the
  partial unique index guarantees the one `'generating'` row is the one it just
  inserted. A *timeout* is not the same: WF-03 answers 202 and then runs for
  minutes, and releasing there would strand the result, since WF-03 PATCHes
  `?status=eq.generating` and would match nothing. Those keep the lock and wait
  for the 15-minute reaper.
- **The app owns the 6-hour digest staleness check.** WF-03 ignores
  `last_digest_at` / `force_refresh` and generates whenever it is called. The app
  only calls it when a digest is genuinely due, and the partial unique index on
  `digests.status='generating'` prevents concurrent runs.

### Open
- **Do Config Loader and Manual Trigger exist as live workflows?** Unknown.
  Competitor management and Run Now are wired but dead without them.
- **Config Loader must reconcile, not just apply.** The payload always carries all
  seven signals. `enabled: false` on a signal with an `apify_schedule_id` means
  *delete the Apify schedule and NULL the column* — skipping that leaves a
  cancelled signal still scraping and still billing.

### Handoff docs
- `docs/WF-03-handoff.md` — checklist for building WF-03 in the n8n session
- `docs/n8n-claude-calls.md` — request bodies, system prompts, JSON schemas
- `docs/wiring-app-to-n8n.md` — connecting the two once the workflows exist

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues; use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo with `CONTEXT.md` and `docs/adr/` at the root. See `docs/agents/domain.md`.
