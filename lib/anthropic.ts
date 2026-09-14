import "server-only";

import Anthropic from "@anthropic-ai/sdk";

/**
 * The app's own edge to Claude.
 *
 * This is a deliberate exception to the rule stated in CLAUDE.md that Claude is
 * called only from n8n, and it is worth understanding why before adding a third
 * caller here.
 *
 * n8n owns the pipeline: WF-02 interprets every incoming signal, WF-03 writes the
 * briefing. Both run unattended, both are fire-and-forget, and neither has a user
 * waiting on the other end. That is exactly what n8n is good at.
 *
 * Two things do not fit that shape:
 *
 *   Chat — a reply has to stream token by token or it feels broken. n8n cannot
 *   stream a response body to a browser; the best it can do is answer once the
 *   whole workflow finishes, which for a thinking model is a multi-second dead
 *   wait per turn with no feedback.
 *
 *   On-demand analysis — the operator is watching. A round trip through a webhook
 *   that writes to Supabase and waits for Realtime to bring the answer back adds
 *   latency to a request whose entire point is that it happens now.
 *
 * So the app holds an Anthropic key. Everything automated stays in n8n.
 *
 * `server-only` is load-bearing here for the same reason it is in lib/n8n.ts:
 * importing this from a Client Component must be a build error, not a leaked key.
 */

/**
 * Both app-side calls use Opus 5.
 *
 * Not a cost oversight — the volume is completely different from the pipeline's.
 * WF-02 runs on every scraped change, dozens of times a day, which is why it uses
 * Sonnet. These two run only when the operator clicks something: a handful of
 * analyses and a few chat turns. That is the one place in this system where the
 * strongest model is affordable, and it is also where the reasoning is hardest —
 * "what should I do about this, given my catalogue and margins" is a genuinely
 * harder question than "what changed on this page".
 */
export const CHAT_MODEL = "claude-opus-5";
export const ANALYSIS_MODEL = "claude-opus-5";

/**
 * Whether the key is present.
 *
 * Checked rather than assumed so the feature can fail soft, the same way the n8n
 * webhooks do when their URLs are blank: chat and analysis report themselves as
 * unavailable and the rest of the app keeps working. A missing key should not
 * take down the alert feed.
 */
export function isAnthropicConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

let client: Anthropic | null = null;

/**
 * The shared client. Constructed once — the SDK holds a connection pool, and a
 * new instance per request throws that away.
 *
 * Throws rather than returning null when unconfigured. Every caller checks
 * `isAnthropicConfigured()` first and reports a clean "not set up" state, so
 * reaching this error means a caller skipped that check.
 */
export function anthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Chat and on-demand analysis need it; " +
        "the signal pipeline and briefings do not (n8n holds its own key). " +
        "Add it to .env.local — see .env.local.example.",
    );
  }
  client ??= new Anthropic();
  return client;
}

/**
 * Pull the text out of a response, or explain why there is none.
 *
 * Three failure modes worth separating, all of which arrive as HTTP 200:
 *
 *   refusal    — a safety classifier declined. Rare for this subject matter, but
 *                the operator should be told that rather than shown a blank box.
 *   max_tokens — the reply was cut off mid-sentence. Silently returning the
 *                fragment makes Claude look like it trailed off for no reason.
 *   no text    — the response was all thinking and no answer.
 */
export function textFromMessage(message: {
  content: Array<{ type: string; text?: string }>;
  stop_reason?: string | null;
  stop_details?: { category?: string | null } | null;
}): { ok: true; text: string } | { ok: false; error: string } {
  if (message.stop_reason === "refusal") {
    const category = message.stop_details?.category;
    return {
      ok: false,
      error: category
        ? `Claude declined to answer this one (${category}).`
        : "Claude declined to answer this one.",
    };
  }

  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("")
    .trim();

  if (!text) {
    return { ok: false, error: "Claude returned no answer. Try again." };
  }

  if (message.stop_reason === "max_tokens") {
    return { ok: false, error: "The answer was cut off before it finished." };
  }

  return { ok: true, text };
}
