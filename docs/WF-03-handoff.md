# WF-03 handoff

Take this into the n8n session. Everything here is settled — no decisions left
except the one flagged at the bottom.

Full detail (system prompt, JSON schema, exact request body) lives in
`/Users/ajay/Documents/AI consultancy/VS/real-lead/docs/n8n-claude-calls.md` § 2.
Open it from wherever you are; this file is the checklist.

---

## Facts the n8n session needs

| | |
|---|---|
| Supabase project | `https://pxapdvewyaccchhdxruf.supabase.co` |
| Supabase auth in n8n | **service_role** key — already set, confirmed working |
| Model | `claude-opus-5` |
| Target table | `public.digests` — already created, see `supabase/01-app-layer.sql` § 1.4 |

---

## Build checklist

- [ ] **Webhook node → Response Mode: `Immediately`**
- [ ] **"Respond to Webhook" node returning `202`, placed before anything else**
- [ ] Webhook node → Authentication → **Header Auth** credential
      (header name `x-webhook-secret`; create the credential, don't use `$env`)
- [ ] Read unread alerts: `GET /rest/v1/alerts?is_read=eq.false&order=created_at.desc`
- [ ] Claude call: `claude-opus-5`, `max_tokens: 16000`, `output_config.effort: "high"`,
      **omit the `thinking` field entirely** (Opus 5 runs adaptive by default)
- [ ] HTTP Request node timeout → `600000` (10 min)
- [ ] Success → `PATCH /rest/v1/digests?status=eq.generating`
- [ ] **Error branch → same PATCH with `status='failed'` + `error`**
- [ ] Workflow set to **Active**, and copy the `/webhook/` production URL
      (not `/webhook-test/` — that only fires while the editor is open)

---

## The write-back, exactly

The app inserts a row with `status='generating'` to take a lock *before* calling
the webhook. A partial unique index guarantees only one such row exists, so n8n
finds it without needing an id:

```
PATCH /rest/v1/digests?status=eq.generating
```

```json
{
  "status": "ready",
  "headline": "...",
  "priority_action": { "action": "...", "why_now": "...", "competitor": "...", "related_alert_ids": ["..."] },
  "patterns": [ { "pattern": "...", "competitors_involved": ["..."], "evidence_alert_ids": ["..."] } ],
  "quiet_competitors": ["..."],
  "alert_ids": [1, 2, 3],
  "alert_count": 3,
  "period_start": "...",
  "period_end": "...",
  "claude_usage": { "input_tokens": 0, "output_tokens": 0 },
  "generated_at": "..."
}
```

`alert_ids` is **`bigint[]`** — send integers. `alerts.id` is a bigint sequence,
not a uuid.

---

## The one that bites

**If WF-03 exits without PATCHing, the lock is never released.** The row stays
`'generating'`, the app shows a permanent loading state, and every future digest
request is rejected until `reap_stale_digests()` clears it 15 minutes later.

So the error branch must write, not just log.

---

## Bring back with you

1. The three production webhook URLs (Config Loader, Manual Trigger, Digest)
2. Whether **Config Loader** and **Manual Trigger** exist as live workflows yet —
   the app's competitor management and Run Now are wired but unusable without them
3. The `N8N_WEBHOOK_SECRET` value you set in the Header Auth credential
4. Whether the Realtime smoke test passed (see below)

---

## Still unverified in the app

**The Realtime test was never run.** WF-03's whole async design depends on it: the
webhook returns `202` and the finished digest reaches the browser over Realtime. If
Realtime is not delivering, WF-03 will look broken when it is not.

With the Signals page open at `localhost:3000`, run this in the Supabase SQL Editor:

```sql
insert into public.alerts (
  workflow, competitor_id, competitor_name, signal_type, severity,
  summary, recommended_action, ai_available, dedupe_key,
  product_title, currency, previous_price, current_price, delta_pct
)
select 'WF-02-manual-test', id, name, 'sku_price_change', 'critical',
       'Death Wish Coffee cut their 16oz dark roast from $19.99 to $14.99, a 25% drop.',
       'Match to $15.99 on your comparable SKU or bundle it before the weekend.',
       true, 'realtime-smoke-' || gen_random_uuid()::text,
       '16oz Dark Roast', 'USD', 19.99, 14.99, -25.0
  from public.competitors where name = 'Death Wish Coffee';
```

It should appear at the top of the feed within a second, no refresh. Then:

```sql
delete from public.alerts where workflow = 'WF-02-manual-test';
```

| What you see | Meaning |
|---|---|
| Indicator "Live", row appears | Working — nothing to do |
| "Live", nothing appears | `alerts` not in the `supabase_realtime` publication |
| "Reconnecting" | RLS SELECT policy on `alerts` not matching |

---

## Decision: the app owns staleness — WF-03 does not check it

Settled. The app reads the last `digests` row, decides whether 6 hours have passed,
and only then takes the lock and calls the webhook.

**So WF-03 should ignore `last_digest_at` and `force_refresh` entirely.** If the
webhook fires, generate. Do not add a staleness branch — the app will not call it
unless a digest is genuinely due, and the partial unique index on
`status='generating'` already prevents concurrent runs.

Those two fields stay in the payload as diagnostic context (they show up in the
execution log, which is useful when working out why a run happened), but nothing
should branch on them.
