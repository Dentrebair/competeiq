# Claude API calls for WF-02 and WF-03

Reference for when you next work on the n8n workflows. Two different models for two
different jobs. Nothing here touches the Next.js app.

- **WF-02** (per-signal interpretation) → `claude-sonnet-5`, thinking off, low effort
- **WF-03** (daily digest) → `claude-opus-5`, thinking on, high effort

Model IDs are exact and take **no date suffix**. `claude-sonnet-5`, not
`claude-sonnet-5-20260101`.

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

### Request body

```json
{
  "model": "claude-sonnet-5",
  "max_tokens": 1024,
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
            "enum": [
              "price_drop",
              "price_increase",
              "new_product",
              "promotion",
              "homepage_copy",
              "ad_creative",
              "newsletter",
              "review_shift"
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

HANDLING BAD INPUT

If the diff is empty, contradictory, or the snapshot looks truncated, set confidence
to low, say what is missing in the summary, and set severity to low. Do not invent a
change that is not in the data. Do not guess at units — if a price could be cents or
dollars, say the unit is ambiguous rather than picking one.
```

That prompt is roughly 450 tokens. **Sonnet 5's minimum cacheable prefix is 1024
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

  const userContent = [
    `Competitor: ${d.competitor_name} (${d.competitor_domain})`,
    `Signal type: ${d.signal_type}`,
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
        max_tokens: 1024,
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
              }
            },
            "required": ["action", "why_now", "competitor", "related_alert_ids"],
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

const userContent = [
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

### Node settings

| Setting | Value |
|---|---|
| Timeout | `600000` |
| Retry on Fail | on, Max Tries `2`, Wait Between Tries `5000` |
| On Error | *Continue (using error output)* → leave the previous digest in place |

Never overwrite a good digest with a failed one. On error, keep the existing row and
let the app show the stale digest with its real timestamp.

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
