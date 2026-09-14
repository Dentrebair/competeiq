# Claude API calls for WF-02 and WF-03

Reference for when you next work on the n8n workflows. Two different models for two
different jobs. Nothing here touches the Next.js app.

- **WF-02** (per-signal interpretation) → spec'd as `claude-sonnet-5`, thinking off, low
  effort. **Deployed as `claude-haiku-4-5`** — see the status section below.
- **WF-03** (daily digest) → `claude-opus-5`, thinking on, high effort

Model IDs are exact and take **no date suffix**. `claude-sonnet-5`, not
`claude-sonnet-5-20260101`.

---

## Deployed WF-02 — status as of 2026-08-27

**Read this before section 1.** Section 1 below describes a WF-02 that was specified
and never built. The deployed workflow
(`/Users/ajay/VS/N8N/n8n-workflows/wf-02-signal-processor.json`, live as
`DNbYTKg9l6y4DJnW`) differs from it in almost every respect that matters, and
following section 1 literally would rebuild WF-02 rather than modify it. **The
system prompt actually in production is reproduced verbatim further down this
section** — section 1's prompt is the superseded spec text.

| | Section 1 says | WF-02 actually does |
|---|---|---|
| Model | `claude-sonnet-5` | `claude-haiku-4-5` |
| `max_tokens` | 2048 | **700** (was 300; raised 2026-08-26) |
| Output | `output_config.format` + JSON schema | Prompt-instructed JSON, unwrapped by a fence-tolerant parser with fallbacks |
| `signal_type` | Claude picks it from an enum | **Set by the diff nodes** (`Diff Price` / `Diff Catalog` / `Diff Promo`) — Claude never sees the choice |
| `severity` | Claude picks it from a four-level rubric | **Computed in `Normalize Alert`** from magnitude. Claude still returns the key, but it is discarded |
| `confidence` | Returned and discarded for want of a column | **Never requested and never returned** |
| Caching | `cache_control` on the system prompt | No `cache_control` at all — deliberate, see below |
| Severity values | critical / high / medium / low | high / medium / low — **`critical` never occurs** |

WF-03 is the opposite case: the deployed workflow matches section 2 closely —
`claude-opus-5`, `max_tokens: 16000`, `effort: high`, adaptive thinking, a real
`json_schema`, and `cache_control`. Its change applies as written.

### The signal-vocabulary alarm was a false alarm

An earlier version of this document told you six of the eight `signal_type` values
were violating the CHECK constraint and needed fixing first. **That was wrong about
the deployed workflow.** The enum in section 1 belongs to the unbuilt spec. In the
real WF-02, `signal_type` is assigned by whichever diff node produced the change and
is already `sku_price_change` / `catalog_change` / `promo_discount` — which is why
migration 03 found every existing row conforming and added the constraint cleanly.

Nothing to fix. No reconciliation of existing rows is needed.

### Why Claude's severity is thrown away — and what that implies

`Normalize Alert` computes severity from the size of the move rather than accepting
Haiku's judgement, and the code says why: in execution 4271 two identical −33%
promos came back `low` and `medium`, and a −50% discount came back `low`. Magnitude
is a property of the data, so it is derived:

```
sku_price_change   |delta| >= 15 -> high, >= 5 -> medium, else low
promo_discount     |delta| >= 50 -> high, >= 35 -> medium, else low
catalog_change     removed_count > 0 -> medium, else low
```

That is a good decision, and it should govern the two new fields as well. **Do not
take `confidence` from Haiku** — it is the same class of subjective judgement that
proved unreliable for severity, and a confidence rating nobody can trust is worse
than none, because the UI presents it as a reason to believe the rest.

Two honest options for `confidence`, in preference order:

1. **Skip it.** The column exists and stays null; the chip is simply not rendered.
   Nothing downstream breaks.
2. **Derive it in `Normalize Alert`**, the same way severity is derived — `low` when
   the diff is partial (no `previous_price`, missing handle, a baseline run), `high`
   otherwise. Deterministic and explainable.

### What to change in WF-02 — and what is already done

| # | Node | Change | Status |
|---|---|---|---|
| 1 | `Build Claude Prompt` | Raise `max_tokens` from **300** to about **700**. A two-to-three-sentence `impact` cannot fit in 300 alongside the summary and action. | **Done** |
| 2 | `Build Claude Prompt` | Add `impact` to the system prompt's required JSON shape, and add a sentence describing it. | **Done** |
| 3 | `Build Claude Prompt` | Add the brand-profile block to the user message. | Not done |
| 4 | `Parse Claude` | Add `if (!parsed.impact) parsed.impact = null;` to the field guards, so a malformed response degrades one field instead of the alert. | **Done** |
| 5 | `Normalize Alert` | Add `impact: a.impact || null` to the returned object. | **Done** |
| 6 | New node | `Read Brand Profile` before `Build Claude Prompt`. | Not done |
| 7 | `Normalize Alert` | Optional — derive `confidence` here if you want it. | Not done |

The system prompt was rewritten on **2026-08-27**, which is what closed items 1, 2, 4
and 5. Items 3 and 6 are still open, and the deployed prompt says so out loud — it
tells the model no brand profile is supplied *yet* and to generalise. Wiring
`Read Brand Profile` is a user-message change; the system prompt needs one sentence
edited when that lands (the "No brand profile is supplied yet" clause in IMPACT).

### The deployed system prompt — verbatim, 2026-08-27

This is what `Build Claude Prompt` sends today. It lives in the Code node as a
template literal on line 1, `const SYSTEM_PROMPT = \`...\`;`, and line 14 of that node
is just `system: SYSTEM_PROMPT,`. A template literal rather than the old escaped
single-quoted string, because the text contains apostrophes and em dashes and every
`\'` was a place to get it wrong.

```
You interpret competitor signals for a single ecommerce/D2C brand.

Your reader is the brand owner. They are busy and commercially literate. They will read your two sentences and act on your one action — write for that.

SUMMARY — exactly two sentences.
First: what changed and what kind of move it is. Second: what it implies commercially.
The competitor name, the product, the old price, the new price and the percentage are ALREADY DISPLAYED beside your text. Do not restate them. Never write "significant", "notable" or "appears to be" — give the figure instead.

IMPACT — two or three sentences.
What this does to the reader's business: which of their products it lands on, which price positions it pressures, which customers it pulls at. No brand profile is supplied yet, so say what it means for a brand competing in this category and make clear you are generalising. Never invent their margins, customer mix or sales — nothing in this system knows those.

RECOMMENDED ACTION — one sentence.
Specific enough to start today. Name the lever and the target: which SKU to reprice, which bundle to build, which ad angle to test, which segment to email. If no action is warranted, say so plainly and say what would change your mind. Never write "monitor", "keep an eye on", "consider reviewing" or "evaluate your options" — those are not actions.

Respond ONLY with valid JSON in this exact format:
{"severity":"high|medium|low","summary":"2 sentences here","impact":"2-3 sentences here","recommended_action":"1 sentence here"}
```

Differences from section 1's prompt worth knowing before you edit either:

- **No severity rubric.** The ~45-word four-level rubric is gone. `severity` stays in
  the required JSON shape because `Parse Claude` guards for it and the Sheets node
  maps it, but `Normalize Alert` overwrites it. Keeping the key and dropping the
  rubric is the point: the model stops spending judgement on a field nobody reads.
- **No signal-type vocabulary.** The diff nodes set `signal_type`; Claude never
  chooses it, so the seven-value enum is not in the prompt at all.
- **No `confidence`.** Never requested, never returned. See the section above for why.
- **The prompt now tells the model what NOT to restate.** Competitor, product, old
  price, new price and percentage are all rendered beside the text in the app, so the
  summary repeating them wasted both sentences. This is the single biggest quality
  change in the rewrite and it only makes sense in the presence of the app UI.
- **Banned phrasings are explicit** — "significant" / "notable" / "appears to be" in
  the summary, "monitor" / "keep an eye on" / "consider reviewing" / "evaluate your
  options" in the action.

**Do not add `cache_control` to this.** The prompt measures **1,528 characters,
about 382 tokens**. Sonnet's minimum cacheable prefix is 1,024 tokens and Haiku 4.5's
is 2,048 — at 382 the cache silently does nothing while still billing the 1.25× write
premium, and `cache_creation_input_tokens` comes back `0` with no error to tell you.
Recount before adding it if the prompt ever grows.

The deployed request body, for reference — no `thinking`, no `output_config`, no
`json_schema`, system as a plain string:

```json
{
  "model": "claude-haiku-4-5",
  "max_tokens": 700,
  "system": "<the prompt above>",
  "messages": [
    { "role": "user", "content": "Competitor: ...\nSignal: ...\nDetail: ..." }
  ]
}
```

**`Insert Alert` needs no change at all.** It POSTs
`JSON.stringify($('Normalize Alert').item.json)` wholesale to
`/rest/v1/alerts?on_conflict=dedupe_key`, so any key added to `Normalize Alert`'s
return is inserted automatically. Adding `impact` there is the entire deployment
step for that column.

### The open question — is Haiku enough for `impact`?

`impact` asks for commercial reasoning about the operator's own catalogue against a
competitor's move — the same kind of judgement that produced the severity problem
above. The 2026-08-27 rewrite spends most of its new words on that field, so the
prompt is no longer the limiting factor. If the impact lines still come back generic,
the model is the reason: `claude-sonnet-5` is the next step up and the cost section
below already prices it.

**Not yet tested.** The rewritten prompt was deployed on 2026-08-27 but no signal has
been run through it — WF-02 is inactive and `/webhook-test/signal-processor` needs
*Listen for test event* clicked in the editor plus the `X-Signal-Token` value from
credential `6DBZxLmXlK9Df4aR`. Judge Haiku on five real alerts before switching
models; swapping the model on a prompt you have never seen output from tells you
nothing about which one fixed it.

### WF-03 — nothing required yet

`alternatives` on `priority_action` was on this list. **The app does not read it.**

Every "business decisions to consider" block in the console — Overview, Alerts and
Intelligence — renders `alert_analyses.alternatives`, which the app generates itself
on demand through `analyzeAlert()`. Nothing renders the digest's alternatives: the
Reports view reads only `priority_action.action` and `.why_now`.

So the whole decision-options feature works today with no workflow change at all.
Add `alternatives` to WF-03 only after something displays it — otherwise it is a
field being written for nobody, which is how the `confidence` situation started.

The instructions in section 2 are still correct if and when that changes.

---

## 0. Things to settle before wiring either node

**Credentials.** In the HTTP Request node, set Authentication →
*Predefined Credential Type* → Anthropic if your node version offers it. If it
doesn't, use Generic → Header Auth with header name `x-api-key`. Never put the key
in the URL query string — it gets written to every execution log.

**Build the body in a Code node, not in the HTTP node's JSON field.** Escaping n8n
`{{ }}` expressions inside a raw JSON string is where these break. Pattern:

```
Code node ("Build Claude Request")  →  HTTP Request node
```

In the HTTP Request node: Body Content Type `JSON`, Specify Body `Using JSON`,
JSON field = `{{ JSON.stringify($json.body) }}`.

**Check `typeVersion` against a working node on your instance** before assuming the
HTTP Request node supports a field. Read it off an existing WF-02 node rather than
trusting the docs.

**Verify with one real curl call first.** Send one actual request, look at the real
response body, and map fields from that. Do not wire the parse node against an
imagined payload.

---

## 1. WF-02 — signal interpretation

> ⚠️ **This section is the original specification, not the deployed workflow.** It
> was written before WF-02 was built and the build diverged — different model, no
> structured outputs, a much smaller token ceiling, and severity and signal_type
> both decided outside Claude. See the comparison table under *Changes to apply*
> above, and make your edits against the real nodes rather than against this.
> Kept because the prompt guidance below is still the best statement of what the
> summary and action are for — but the prompt text in this section is **superseded**
> by the verbatim deployed prompt above (rewritten 2026-08-27). Edit that one.

### Request body

```json
{
  "model": "claude-sonnet-5",
  "max_tokens": 2048,
  "thinking": { "type": "disabled" },
  "output_config": {
    "effort": "low",
    "format": {
      "type": "json_schema",
      "schema": {
        "type": "object",
        "properties": {
          "severity": {
            "type": "string",
            "enum": ["critical", "high", "medium", "low"]
          },
          "signal_type": {
            "type": "string",
            "description": "Which of the seven monitored signals this change is. Must be one of these exact strings — alerts.signal_type is constrained to them in Postgres, and anything else is rejected at insert.",
            "enum": [
              "sku_price_change",
              "catalog_change",
              "promo_discount",
              "ad_creative",
              "review_sentiment",
              "website_change",
              "newsletter"
            ]
          },
          "summary": {
            "type": "string",
            "description": "Exactly two sentences of plain English. State what changed and what it implies commercially. No preamble, no 'Based on the data'."
          },
          "recommended_action": {
            "type": "string",
            "description": "One specific action the brand owner could take this week. Name the lever (price, bundle, ad copy, email) and the target. Not 'monitor the situation'."
          },
          "impact": {
            "type": "string",
            "description": "Two or three sentences on what this change does to THIS brand's position specifically — which of their products, which price positions, which customers. Use the brand profile in the user message. If no profile was supplied, say what the change means for a brand competing in this category and say that you are generalising."
          },
          "confidence": {
            "type": "string",
            "enum": ["high", "medium", "low"],
            "description": "low when the diff is ambiguous or the snapshot looks partial."
          }
        },
        "required": [
          "severity",
          "signal_type",
          "summary",
          "recommended_action",
          "impact",
          "confidence"
        ],
        "additionalProperties": false
      }
    }
  },
  "system": [
    {
      "type": "text",
      "text": "<SYSTEM PROMPT — see below>",
      "cache_control": { "type": "ephemeral" }
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": "<PER-SIGNAL PAYLOAD — see below>"
    }
  ]
}
```

Why each field is set that way:

- `thinking: disabled` — Sonnet 5 runs adaptive thinking *by default* when you omit
  the field. Leaving it out means extra tokens and slower webhook responses on every
  single alert. Turn it off for classification.
- `effort: low` — this is a bounded extraction task. Low effort scopes the work to
  what was asked.
- `output_config.format` — guarantees the response parses, so a malformed reply can
  never break the downstream Supabase/Sheets node. This is the main reliability win.
- `system` as an **array** with `cache_control` — required to cache. A plain string
  system prompt cannot carry cache control.

> **`max_tokens` was 1024 and is now 2048.** Adding `impact` adds two or three
> sentences to every response. Truncation here is not a partial answer — the JSON
> is cut mid-string, the parse node throws, and the signal falls to the error
> branch and is written as *Unclassified*. The headroom costs nothing (you are
> billed for tokens generated, not for the ceiling) and the failure it prevents is
> a silent quality regression, not a visible error.

### System prompt

Keep this stable byte-for-byte across calls, or caching does nothing. Volatile stuff
(competitor name, timestamps, the diff) goes in the user message, never here.

```
You interpret competitor signals for a single ecommerce/D2C brand. You receive a
before-and-after snapshot of one competitor property plus a computed diff, and you
return a severity rating, a two-sentence summary, and one recommended action.

Your reader is the brand owner. They are busy, commercially literate, and do not
want analysis — they want to know whether this matters and what to do. Write as if
they will read only your two sentences and act on your one action.

SEVERITY RUBRIC

critical — a change that costs the brand revenue this week if ignored. A price cut
that undercuts the brand on a directly comparable SKU. A competitor launching into
the brand's core category. A promotion running during a period the brand also sells
into (peak season, a holiday window, a launch the brand has scheduled).

high — a change that shifts the competitive position but not immediately. A new
product adjacent to the brand's range. A sustained pricing trend across several SKUs
rather than one. A messaging pivot on the homepage that repositions the competitor
against the brand. A newsletter campaign pushing a category the brand competes in.

medium — a change worth knowing that does not demand a response. Restocks. Minor
copy edits. A promotion on products the brand does not sell. Review volume shifting
without the rating moving.

low — housekeeping. Image swaps, sold-out flags, cosmetic layout changes, price
changes under 3% that read as rounding or currency drift.

When a signal sits between two levels, choose the lower one. Inflated severity
trains the reader to ignore the feed.

CHOOSING THE SIGNAL TYPE

Exactly one of seven, and it describes the monitored surface the change happened
on, not a category you invent for the event:

  sku_price_change  — a product's price moved.
  catalog_change    — products added, removed, or renamed.
  promo_discount    — a promotion, sale, code, or shipping offer started or ended.
  ad_creative       — a change in the ads they are running.
  review_sentiment  — customer review volume or rating shifted.
  website_change    — homepage or key page copy, layout, or messaging changed.
  newsletter        — an email campaign went out.

If a change spans two, pick the one the brand owner would act on. A sitewide sale
banner is promo_discount, not website_change.

WRITING THE SUMMARY

Two sentences. First: what changed, with the specific number or name. Second: what
it implies for the brand. Use the competitor's actual name and the actual figures
from the diff. Never write "significant", "notable", or "appears to be" — give the
number instead.

WRITING THE ACTION

One action, specific enough to start today. Name the lever and the target: which SKU
to reprice, which bundle to build, which ad angle to test, which segment to email.
If the honest answer is that no action is warranted, say so plainly and say why —
that is more useful than a filler suggestion. Never write "continue to monitor",
"consider reviewing", or "evaluate your strategy".

WRITING THE IMPACT

The summary says what happened. The impact says what it does to the reader's
business — which of their products it lands on, which price positions it pressures,
which customers it pulls at. Two or three sentences.

You may be given a brand profile describing their catalogue, categories, and price
band. Use it: name their categories and figures. If the profile says the catalogue
figures were INFERRED rather than read from a product feed, say what you are
assuming instead of stating it as fact.

If no profile is supplied, say what the change means for a brand competing in this
category and make clear you are generalising. Never invent their margins, their
customer mix, or their sales — nothing in this system knows those.

HANDLING BAD INPUT

If the diff is empty, contradictory, or the snapshot looks truncated, set confidence
to low, say what is missing in the summary, and set severity to low. Do not invent a
change that is not in the data. Do not guess at units — if a price could be cents or
dollars, say the unit is ambiguous rather than picking one.
```

**Recount this after the changes above.** The prompt was roughly 450 tokens; adding
`CHOOSING THE SIGNAL TYPE` and `WRITING THE IMPACT` puts it near 750 — larger, but
still under the floor, so `cache_control` continues to do nothing. Either grow it
past 1024 deliberately or drop `cache_control` and stop paying the write premium.
The original note follows.

That prompt was roughly 450 tokens. **Sonnet 5's minimum cacheable prefix is 1024
tokens** — below that, caching silently does nothing and `cache_creation_input_tokens`
comes back as `0`. Either grow the prompt past 1024 tokens (adding few-shot examples
of good vs. bad summaries is the useful way to spend those tokens) or drop
`cache_control` entirely. There is no error either way, so check the field.

Also: default cache TTL is 5 minutes. If your Apify webhooks arrive further apart
than that, every call pays the 1.25× cache-write premium and never gets a read —
worse than no caching. Either add `"ttl": "1h"` to the `cache_control` object (2×
write, needs 3+ reads to pay off) or leave caching off until signal volume is high
enough to justify it.

### Code node: build the body

```js
// "Build Claude Request" — runs once per signal item
const SYSTEM_PROMPT = `...paste the prompt above...`;

const SCHEMA = { /* paste the schema object above */ };

return $input.all().map(item => {
  const d = item.json;

  // ONE vocabulary. The surface we monitored and the signal_type Claude returns
  // are the same seven strings — see lib/signals.ts and the CHECK constraint in
  // supabase/03-ownership-hardening.sql. Do not translate between them.
  //
  // The brand profile goes in the USER message, never in SYSTEM_PROMPT. It changes
  // whenever the operator edits their profile or re-reads their store, and volatile
  // content inside the cached prefix invalidates the cache on every change while
  // looking like it is working. Check cache_read_input_tokens if in doubt.
  // $('Node Name') THROWS if that node did not execute, and .first() throws on an
  // empty output — which is the normal state before onboarding has ever run. Both
  // would fail the whole signal over missing optional context.
  let brand = null;
  try {
    brand = $('Read Brand Profile').first()?.json ?? null;
  } catch (e) {
    brand = null;
  }
  const brandBlock = brand && brand.url
    ? [
        '<brand_profile>',
        'This is the business you are advising.',
        `Brand: ${brand.name ?? brand.url}`,
        brand.categories?.length ? `Sells: ${brand.categories.join(', ')}` : null,
        brand.product_count != null ? `Products: ${brand.product_count}` : null,
        brand.price_min != null ? `Price range: ${brand.currency ?? ''} ${brand.price_min}–${brand.price_max}` : null,
        brand.audience ? `Audience (inferred): ${brand.audience}` : null,
        brand.positioning ? `Positioning (inferred): ${brand.positioning}` : null,
        brand.priorities ? `Their stated priorities: ${brand.priorities}` : null,
        brand.catalogue_source === 'inferred'
          ? 'NOTE: these catalogue figures were INFERRED from their website, not read from a product feed. They may be wrong.'
          : null,
        '</brand_profile>',
        '',
      ].filter(Boolean).join('\n')
    : '';

  const userContent = [
    brandBlock,
    `Competitor: ${d.competitor_name} (${d.competitor_domain})`,
    `Monitored signal: ${d.signal_type}`,
    `Detected at: ${d.detected_at}`,
    '',
    'Previous snapshot:',
    JSON.stringify(d.previous_snapshot, null, 2),
    '',
    'Current snapshot:',
    JSON.stringify(d.current_snapshot, null, 2),
    '',
    'Computed diff:',
    JSON.stringify(d.diff, null, 2),
  ].join('\n');

  return {
    json: {
      // carry the identifiers through so the parse node can attach them
      competitor_id: d.competitor_id,
      signal_config_id: d.signal_config_id,
      snapshot_id: d.snapshot_id,
      body: {
        model: 'claude-sonnet-5',
        max_tokens: 2048,
        thinking: { type: 'disabled' },
        output_config: {
          effort: 'low',
          format: { type: 'json_schema', schema: SCHEMA },
        },
        system: [
          { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content: userContent }],
      },
    },
  };
});
```

### Code node: parse the response

```js
// "Parse Claude Response"
const out = [];

for (const item of $input.all()) {
  const msg = item.json;

  if (msg.stop_reason === 'refusal') {
    throw new Error(`Claude refused: ${msg.stop_details?.category ?? 'unknown'}`);
  }
  if (msg.stop_reason === 'max_tokens') {
    throw new Error('Response truncated — raise max_tokens');
  }

  const textBlock = (msg.content ?? []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text block in response');

  const alert = JSON.parse(textBlock.text);

  out.push({
    json: {
      ...alert,
      input_tokens: msg.usage?.input_tokens,
      output_tokens: msg.usage?.output_tokens,
      cache_read_input_tokens: msg.usage?.cache_read_input_tokens,
    },
  });
}

return out;
```

Watch `cache_read_input_tokens` on the second and later calls. If it stays `0`, the
prefix is under the 1024-token minimum or something volatile crept into the system
prompt.

### Brand profile as context

New node, placed **before** "Build Claude Request". A Supabase (or HTTP Request)
node reading the single profile row:

```
GET /rest/v1/brand_profile?select=*&limit=1
```

Name it exactly **`Read Brand Profile`** — the Code node above reaches it by name.

Two things about it, both of which are normal rather than errors:

- **It returns zero rows until onboarding has run.** The guard in the Code node
  handles that and sends no profile block; Claude falls back to generalising, and
  the prompt tells it to say so.
- **It must not fail the signal.** Set On Error to *Continue*. A missing profile
  should cost you a less specific impact line, never a dropped alert.

### Supabase node: writing the alert

This node was never documented here, which is a gap — it is where two of the
changes in this round actually land.

`INSERT` into `alerts`. Full mapping:

| Column | Source | Notes |
|---|---|---|
| `workflow` | literal `'WF-02'` | |
| `execution_id` | `{{ $execution.id }}` | |
| `competitor_id` | carried from the trigger | |
| `competitor_name` | carried from the trigger | Denormalised on purpose — the alert outlives its competitor |
| `signal_type` | Claude | Must be one of the seven. See step 1 above |
| `severity` | Claude | |
| `summary` | Claude | |
| `recommended_action` | Claude | |
| `impact` | Claude | **New this round** |
| `confidence` | Claude | **New this round** — the value was always returned and always discarded |
| `product_title` / `product_handle` / `product_url` | the diff | Null for non-product signals |
| `currency` / `previous_price` / `current_price` / `delta_pct` | the diff | Numbers, not strings |
| `ai_available` | `true` here, `false` on the error branch | |
| `dedupe_key` | your existing scheme | |

**Do not send** `id` or `created_at` (defaults), and do not send `is_read` or
`read_at` — those belong to the app, and column grants will reject them.

> Adding `impact` and `confidence` to this node is the entire deployment step for
> those two fields. The columns already exist (`supabase/05-intelligence-layer.sql`)
> and the app already reads them. Until this node sends them they stay null, and the
> UI simply omits the chip — no error anywhere, which is exactly why it is worth
> checking a real execution rather than assuming.

**The error branch matters too.** When the Claude call fails, still insert the
alert: `ai_available: false`, no `impact`, no `confidence`, and a `summary` built
from the raw diff. The app renders that as *Unclassified* — ungraded, not
low-priority. Dropping the row instead loses the signal permanently, because the
snapshot has already been consumed.

### Node settings

| Setting | Value |
|---|---|
| Timeout | `60000` (thinking is off, so this is generous) |
| Retry on Fail | on, Max Tries `3`, Wait Between Tries `2000` |
| On Error | *Continue (using error output)* |

Wire the error output to a branch that writes the raw Apify payload to Google Sheets.
An unattended webhook workflow that fails silently loses the signal permanently —
the snapshot is already consumed by then.

---

## 2. WF-03 — digest

### Request body

```json
{
  "model": "claude-opus-5",
  "max_tokens": 16000,
  "output_config": {
    "effort": "high",
    "format": {
      "type": "json_schema",
      "schema": {
        "type": "object",
        "properties": {
          "headline": {
            "type": "string",
            "description": "One sentence naming the single most important thing that happened. This is the line the user reads first."
          },
          "priority_action": {
            "type": "object",
            "properties": {
              "action": { "type": "string" },
              "why_now": { "type": "string" },
              "competitor": { "type": "string" },
              "related_alert_ids": {
                "type": "array",
                "items": { "type": "string" }
              },
              "alternatives": {
                "type": "array",
                "minItems": 2,
                "maxItems": 2,
                "description": "Two other postures toward the same situation — genuinely different approaches, not rewordings of the action above. If holding is one of them, include it.",
                "items": {
                  "type": "object",
                  "properties": {
                    "approach": {
                      "type": "string",
                      "description": "Two to four words naming the posture. 'Match on price', 'Hold and differentiate', 'Wait out their promo'."
                    },
                    "action": { "type": "string" },
                    "tradeoff": {
                      "type": "string",
                      "description": "What this one costs them — margin, positioning, time, optionality. One concrete sentence. Never 'may not work' or 'carries some risk'."
                    }
                  },
                  "required": ["approach", "action", "tradeoff"],
                  "additionalProperties": false
                }
              }
            },
            "required": ["action", "why_now", "competitor", "related_alert_ids", "alternatives"],
            "additionalProperties": false
          },
          "patterns": {
            "type": "array",
            "description": "At most three. Only patterns that span more than one alert.",
            "items": {
              "type": "object",
              "properties": {
                "pattern": { "type": "string" },
                "competitors_involved": {
                  "type": "array",
                  "items": { "type": "string" }
                },
                "evidence_alert_ids": {
                  "type": "array",
                  "items": { "type": "string" }
                }
              },
              "required": ["pattern", "competitors_involved", "evidence_alert_ids"],
              "additionalProperties": false
            }
          },
          "quiet_competitors": {
            "type": "array",
            "description": "Competitors with no meaningful signal in the window. Absence is information.",
            "items": { "type": "string" }
          },
          "period_start": { "type": "string", "format": "date-time" },
          "period_end": { "type": "string", "format": "date-time" }
        },
        "required": [
          "headline",
          "priority_action",
          "patterns",
          "quiet_competitors",
          "period_start",
          "period_end"
        ],
        "additionalProperties": false
      }
    }
  },
  "system": [
    {
      "type": "text",
      "text": "<DIGEST SYSTEM PROMPT — see below>",
      "cache_control": { "type": "ephemeral" }
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": "<ALERTS PAYLOAD — see below>"
    }
  ]
}
```

Differences from WF-02, and why:

- **No `thinking` field.** Opus 5 runs adaptive thinking by default. That is what you
  want here — cross-competitor pattern finding is the one genuinely hard reasoning
  task in the system. Do not set `thinking: disabled`.
- `max_tokens: 16000` — on Opus 5, `max_tokens` caps **thinking plus response text
  together**. Size it tightly and the digest truncates mid-answer with
  `stop_reason: "max_tokens"`.
- `effort: high` — this is the default, stated explicitly so it doesn't drift.
  `xhigh` is available if the digests come back shallow, at more tokens and latency.

**Raise the n8n node timeout to `600000` (10 min).** Opus 5 at high effort with
thinking on can run several minutes on a large alert set. The default HTTP Request
timeout will cut it off, and you will see a timeout error rather than the real cause.

### Digest system prompt

```
You write a single morning intelligence briefing for one ecommerce/D2C brand. You
receive every unread competitor alert from the last 24 hours and you return one
headline, one priority action, and up to three cross-cutting patterns.

Your job is synthesis, not summary. The reader has already seen the individual
alerts in their feed. What they cannot see is the shape across them: three
competitors discounting the same category in the same week, a single competitor
moving on price and messaging and paid at once, a category going quiet before a
launch. If you only restate the alerts one by one you have failed the task.

THE HEADLINE

One sentence. The most important thing that happened, named specifically. If nothing
important happened, say that plainly — "A quiet day; no competitor moved on price or
launched into your categories" is a good headline and builds trust in the days when
the headline is urgent.

THE PRIORITY ACTION

Exactly one. The single thing worth doing today, chosen across all alerts, not one
per alert. Name the competitor it responds to, the lever to pull, and why the timing
matters now rather than next week. Cite the alert IDs it rests on so the reader can
click through. If no action is warranted, say so and explain what you would need to
see to change that.

THE ALTERNATIVES

Two, alongside the priority action, and they must be genuinely different postures
toward the same situation — not the same move described three ways. Match on price,
hold and differentiate, wait it out, and do nothing are different postures. "Reduce
the price" and "offer a discount" are one.

Each carries a tradeoff, and the tradeoff is the point. An alternative without a
stated cost is not a choice, it is another suggestion — the reader is picking
between these, and they can only pick if they can see what each one gives up. Make
it concrete: margin, positioning, time, optionality. Never "may not work" or
"carries some risk".

If the honest answer is that holding is the right move, make holding one of the two
and say what would change your mind.

PATTERNS

Only include a pattern if it spans more than one alert. A pattern that rests on a
single alert is just that alert. Cite the alert IDs that evidence it. Zero patterns
is a valid and honest answer on a quiet day — do not manufacture three.

QUIET COMPETITORS

List competitors that produced no meaningful signal in the window. A competitor that
has gone silent before a known launch window is itself a signal.

GROUNDING

Every claim must trace to an alert in the input. Cite alert IDs. Do not carry
forward context from previous digests — you only know what is in this payload. If
the alert set is empty or thin, say so rather than inflating what is there.
```

### User payload

```js
// "Build Digest Request"
const alerts = $input.all().map(i => i.json);

// Same node name and same guard as WF-02 — $('Node Name') throws when that node
// did not execute, and .first() throws on an empty output, which is the normal
// state before onboarding has run.
let brand = null;
try {
  brand = $('Read Brand Profile').first()?.json ?? null;
} catch (e) {
  brand = null;
}

const brandBlock = brand && brand.url
  ? [
      '<brand_profile>',
      `Brand: ${brand.name ?? brand.url}`,
      brand.categories?.length ? `Sells: ${brand.categories.join(', ')}` : null,
      brand.price_min != null ? `Price range: ${brand.currency ?? ''} ${brand.price_min}–${brand.price_max}` : null,
      brand.positioning ? `Positioning (inferred): ${brand.positioning}` : null,
      brand.priorities ? `Their stated priorities: ${brand.priorities}` : null,
      brand.catalogue_source === 'inferred'
        ? 'NOTE: catalogue figures were INFERRED from their website, not read from a feed.'
        : null,
      '</brand_profile>',
      '',
    ].filter(Boolean).join('\n')
  : '';

const userContent = [
  brandBlock,
  `Window: ${$json.period_start} to ${$json.period_end}`,
  `Alert count: ${alerts.length}`,
  `Competitors monitored: ${$json.competitor_names.join(', ')}`,
  '',
  'Alerts:',
  JSON.stringify(
    alerts.map(a => ({
      id: a.id,
      competitor: a.competitor_name,
      signal_type: a.signal_type,
      severity: a.severity,
      summary: a.summary,
      // New this round. Null on alerts written before WF-02 gained the field —
      // that is absence of data, not absence of impact, so leave it out rather
      // than substituting a placeholder.
      impact: a.impact ?? undefined,
      recommended_action: a.recommended_action,
      detected_at: a.detected_at,
    })),
    null,
    2,
  ),
].join('\n');
```

Send the trimmed alert objects, not the full rows. The raw snapshots are already in
Supabase and would just burn input tokens.

The brand profile goes here, in the **user** message — same reason as WF-02. It is
volatile, and volatile content inside a `cache_control` prefix invalidates the cache
every time the operator edits their profile, silently and with no error.

### Node settings

| Setting | Value |
|---|---|
| Timeout | `600000` |
| Retry on Fail | on, Max Tries `2`, Wait Between Tries `5000` |
| On Error | *Continue (using error output)* → write `status='failed'` (see below) |

### Workflow shape — respond before doing anything

```
Webhook (Response Mode: Immediately)
  └─ Respond to Webhook  →  202 Accepted        ← nothing before this
       └─ read unread alerts from Supabase
            └─ HTTP Request → Claude (Opus 5)
                 └─ PATCH the digest row in Supabase
```

The app never reads the digest out of this response — it reads it from Supabase and
gets the update over Realtime. So respond `202` unconditionally, then decide
internally whether the digest is stale enough to warrant a Claude run. "Respond
immediately" and "return the cached digest in the response" cannot both happen.

### Which alerts to read

```
GET /rest/v1/alerts?is_read=eq.false&order=created_at.desc
```

`is_read` is what makes "summarise unread alerts" answerable at all. Send the
trimmed fields listed in the payload section above, not whole rows.

### Writing the result back

**Update the existing lock row — do not insert a new one.** The app inserts a row
with `status='generating'` to take the digest lock before calling this webhook. A
partial unique index guarantees at most one such row exists at any time, so n8n can
find it without needing an id:

```
PATCH /rest/v1/digests?status=eq.generating
Prefer: return=representation
```

On success:

```json
{
  "status": "ready",
  "headline": "...",
  "priority_action": {
    "action": "...",
    "why_now": "...",
    "competitor": "...",
    "related_alert_ids": ["..."],
    "alternatives": [
      { "approach": "...", "action": "...", "tradeoff": "..." },
      { "approach": "...", "action": "...", "tradeoff": "..." }
    ]
  },
  "patterns": [ { "pattern": "...", "competitors_involved": ["..."], "evidence_alert_ids": ["..."] } ],
  "quiet_competitors": ["..."],
  "alert_ids": [1, 2, 3],
  "alert_count": 3,
  "period_start": "2026-08-17T00:00:00Z",
  "period_end": "2026-08-18T00:00:00Z",
  "claude_usage": { "input_tokens": 0, "output_tokens": 0 },
  "generated_at": "2026-08-18T09:00:00Z"
}
```

`alert_ids` is **`bigint[]`**, because `alerts.id` is a bigint sequence rather than a
uuid. Send integers, not strings.

`priority_action` is a **`jsonb`** column, so `alternatives` needs no migration — the
column accepts the new key as it stands. PATCH the whole object; sending it without
`alternatives` silently drops them, and the panel then renders a chevron with nothing
behind it.

On failure, still PATCH the row — set `status='failed'` and put the reason in
`error`. Leaving it at `'generating'` is the one outcome to avoid: the lock stays
held, the app shows a permanent loading state, and every future digest request is
rejected until `reap_stale_digests()` clears it 15 minutes later.

### Who decides staleness

**Decided: the app owns it.** WF-03 must ignore `last_digest_at` and `force_refresh`
entirely and generate whenever it is called.

The app checks the six-hour threshold before taking the lock and only calls this
webhook when a digest is genuinely due; the partial unique index on
`digests.status='generating'` stops concurrent runs. If WF-03 also checks and
declines, the app has already inserted the lock row and nothing will ever clear it
except the fifteen-minute reaper — the panel spins for a quarter of an hour for no
reason. Delete any staleness check still wired into this workflow.

---

## 3. Cost, for reference

Per million tokens: Sonnet 5 `$3 in / $15 out` (introductory `$2 / $10` through
2026-08-31), Opus 5 `$5 / $25`.

At ~3K in / 250 out per alert and ~100 alerts a day, WF-02 on Sonnet 5 runs about
**$26/month**. WF-03 on Opus 5 at ~30K in / 2K out, twice daily, is about
**$12/month**. Both figures assume no cache reads; caching lowers the WF-02 number.

Haiku 4.5 would put WF-02 at roughly $13/month. The $13 saving is not worth the drop
in recommendation quality on the output the product is sold on.

---

## 4. Two gotchas that cost time

**First request per schema is slow.** Structured outputs compile the schema on first
use, then cache it for 24 hours. Your first call after editing a schema will be
noticeably slower. This is normal — do not tune timeouts around it.

**A green execution does not mean it worked.** n8n validation proves the JSON is
well-formed, not that the field names match what the API actually returns. If a node
reads `$json.content[0].text` and Claude returned a thinking block first, the node
runs green and produces nothing forever. Check one real execution's output panel
before trusting the wiring.
