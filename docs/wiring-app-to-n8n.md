# Wiring the app to n8n

Do this once, when the three webhook workflows exist. Direction 2 only
(App → n8n). Direction 1 (Apify → n8n) needs nothing from the app.

## 1. Generate the shared secret

```bash
openssl rand -hex 32
```

One value, used in two places: the app sends it, n8n checks it. Without the check,
those webhook URLs are open endpoints — anyone who finds the Manual Trigger URL can
fire Apify actor runs on your account.

## 2. Authenticate the webhooks — use Header Auth, not `$env`

The obvious approach is a Code node reading `$env.N8N_WEBHOOK_SECRET`. Don't. On a
self-hosted instance that means editing docker-compose and restarting the container,
and newer n8n builds can block env access inside Code nodes entirely
(`N8N_BLOCK_ENV_ACCESS_IN_NODE`).

The Webhook node has this built in:

1. In n8n, **Credentials → New → Header Auth**
2. Name: `x-webhook-secret` · Value: the secret from step 1
3. Save it as something like `REAL-LEAD app secret`
4. On each of the three Webhook nodes, set **Authentication → Header Auth** and pick
   that credential

Better on every axis than the Code node: the secret is encrypted in n8n's credential
store, no container restart, and unauthorised requests are rejected **before** any
workflow logic runs rather than by a node that has to remember to throw.

## 3. Activate the workflows and copy the production URLs

Each Webhook node shows two URLs:

| URL form | When it fires |
|---|---|
| `/webhook-test/...` | **Only** while the workflow is open in the editor and listening |
| `/webhook/...` | Always, but only when the workflow is **Active** |

Use the `/webhook/` one, and toggle each workflow **Active**. The test URL is the
classic trap: everything works while you're building, then silently stops the moment
you close the tab.

## 4. Fill in `.env.local`

```
N8N_WEBHOOK_SECRET=<the value from step 1>
N8N_WEBHOOK_CONFIG_LOADER=https://n8n.srv1816291.hstgr.cloud/webhook/config-loader
N8N_WEBHOOK_MANUAL_TRIGGER=https://n8n.srv1816291.hstgr.cloud/webhook/manual-trigger
N8N_WEBHOOK_DIGEST=https://n8n.srv1816291.hstgr.cloud/webhook/digest-request
```

Paths must match what your Webhook nodes actually expose — the ones above are from
the spec, not read off the instance. Confirm each.

**Restart `npm run dev` afterwards.** Next reads `.env.local` at startup; editing it
while the server runs changes nothing and looks like the secret is wrong.

## 5. Verify each one

The app fails soft by design, so check them individually rather than assuming.

**Config Loader** — go to `/competitors`, change any frequency. Then:

```sql
select signal_type, frequency_hours, apify_schedule_id
  from public.signal_configs
 order by signal_type;
```

`apify_schedule_id` going from `null` to a value is the proof: n8n received the call,
hit the Apify Schedules API, and wrote the id back. The UI's "N not scheduled" badge
should disappear on reload.

**Manual Trigger** — click Run Now on a signal, then check Apify for a run that
started outside its schedule.

**Digest** — see § WF-03 in `n8n-claude-calls.md`. Watch for a `digests` row moving
`generating → ready`.

## What each failure looks like

The app surfaces these as messages rather than throwing, so read them literally:

| Message | Cause |
|---|---|
| "n8n rejected the shared secret" | 401/403 — value in `.env.local` ≠ the Header Auth credential |
| "The n8n workflow is not listening on that URL" | 404 — workflow inactive, or a test URL, or a wrong path |
| "n8n did not respond within Ns" | Reachable but slow. For Digest this is *expected* if the Respond-to-Webhook node isn't first |
| "Could not reach n8n" | DNS/TLS/instance down |
| "Missing required environment variable: N8N_..." | Blank in `.env.local`, or the server wasn't restarted |

## Two things that stay true after wiring

**`manualTrigger` is never retried automatically.** It spends money. After an
ambiguous timeout the Apify run has probably already started, so a retry risks a
second billable run for one click. The failure is surfaced instead — retrying is the
operator's call. `configLoader` does retry, because `upsert_competitor` converges.

**The app keeps working when n8n is down.** Competitors save, alerts keep arriving
(Apify → n8n → Supabase → Realtime bypasses the app entirely), and the only thing
lost is scheduling changes — recoverable with the Sync button.
