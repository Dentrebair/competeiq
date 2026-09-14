# REAL-LEAD

Competitor intelligence for ecommerce and D2C brands. Monitors competitor
storefronts and delivers AI-interpreted alerts when something commercially
meaningful changes — price drops, catalog launches, promotions, ad creatives,
website changes, newsletters.

Single-client deployment: one operator, one login, one dashboard.

## How the pieces fit

The app is the interface layer. The intelligence engine lives in n8n.

```
Apify (scheduled scrape)
  └─ completion webhook ─> n8n WF-02
       └─ diff vs last snapshot ─> Claude ─> writes alerts to Supabase
                                                  │
browser <──── Supabase Realtime (WebSocket) ──────┘
  app ──── POST + x-webhook-secret ────> n8n   (outbound only)
```

The app never receives data from n8n over HTTP. n8n writes to Supabase with the
service role; the browser learns about it over Realtime. That is what keeps alerts
landing while the app is down or mid-deploy.

## Running it

**Node 20.9+ is required** by Next 16. If your shell defaults to something older:

```bash
nvm use 22
```

```bash
npm install
cp .env.local.example .env.local   # then fill in the two Supabase values
npm run dev
```

Open http://localhost:3000. There is no sign-up page — the single operator is
created by hand in the Supabase dashboard under Authentication → Users, with
"Auto Confirm User" ticked.

## Database

Run these in the Supabase SQL Editor, in order. Each is additive and idempotent.

| File | Purpose |
|---|---|
| `supabase/00-existing-schema.reference.sql` | The live schema n8n was built around. **Reference only — do not run.** |
| `supabase/01-app-layer.sql` | RLS, read state, dedupe key, feed indexes, `digests` + lock, realtime publication |
| `supabase/02-signal-configs.sql` | Per-signal monitoring config, backfilled for existing competitors |
| `supabase/03-ownership-hardening.sql` | Column grants separating app-owned from n8n-owned state |
| `supabase/04-revoke-default-grants.sql` | Removes Supabase's default blanket grants |

RLS is not optional here: the anon key ships to the browser, so RLS is the only
thing standing between it and every alert in the database.

## Docs

| | |
|---|---|
| `CLAUDE.md` | Architecture, conventions, current build status, open decisions |
| `docs/n8n-claude-calls.md` | Claude request bodies, system prompts, and JSON schemas for WF-02 and WF-03 |
| `docs/wiring-app-to-n8n.md` | Connecting the app to the three webhooks |
| `docs/WF-03-handoff.md` | Build checklist for the digest workflow |

## Stack

Next.js 16 (App Router, Turbopack) · React 19 · Tailwind CSS v4 · Supabase
(Postgres + Auth + Realtime) · n8n · Apify · Claude via the Anthropic API,
called only from n8n.
