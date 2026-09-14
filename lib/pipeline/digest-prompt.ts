/**
 * The system prompt and schema WF-03 sent to Claude Opus, copied verbatim from
 * docs/n8n-claude-calls.md § 2 — that doc states the deployed workflow matches
 * this section closely (unlike WF-02, which diverged from its own spec).
 *
 * One deliberate omission: `priority_action.alternatives`. The doc's own
 * closing note says to add it only once something displays it, and nothing
 * does — `alert_analyses.alternatives` (rendered by the UI) comes from
 * analyzeAlert(), a separate on-demand call, not from the digest. Writing a
 * field nobody reads is exactly how the discarded `confidence` field started.
 */

export const DIGEST_MODEL = "claude-opus-5";
export const DIGEST_MAX_TOKENS = 16000;
export const DIGEST_EFFORT = "high";

export const DIGEST_SYSTEM_PROMPT = `You write a single morning intelligence briefing for one ecommerce/D2C brand. You
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
the alert set is empty or thin, say so rather than inflating what is there.`;

/**
 * `priority_action.related_alert_ids` / `patterns[].evidence_alert_ids` are
 * strings here, matching the schema WF-03 used — `alerts.id` is bigint, but
 * these are citations inside prose-adjacent JSON, not the `digests.alert_ids`
 * column (which the worker fills in itself from what it actually sent, as
 * real bigints — see generate-digest.ts).
 */
export const DIGEST_SCHEMA = {
  type: "object",
  properties: {
    headline: {
      type: "string",
      description:
        "One sentence naming the single most important thing that happened. This is the line the user reads first.",
    },
    priority_action: {
      type: "object",
      properties: {
        action: { type: "string" },
        why_now: { type: "string" },
        competitor: { type: "string" },
        related_alert_ids: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["action", "why_now", "competitor", "related_alert_ids"],
      additionalProperties: false,
    },
    patterns: {
      type: "array",
      description: "At most three. Only patterns that span more than one alert.",
      items: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          competitors_involved: {
            type: "array",
            items: { type: "string" },
          },
          evidence_alert_ids: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["pattern", "competitors_involved", "evidence_alert_ids"],
        additionalProperties: false,
      },
    },
    quiet_competitors: {
      type: "array",
      description: "Competitors with no meaningful signal in the window. Absence is information.",
      items: { type: "string" },
    },
    period_start: { type: "string", format: "date-time" },
    period_end: { type: "string", format: "date-time" },
  },
  required: ["headline", "priority_action", "patterns", "quiet_competitors", "period_start", "period_end"],
  additionalProperties: false,
} as const;
