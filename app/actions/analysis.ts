"use server";

import {
  ANALYSIS_MODEL,
  anthropic,
  isAnthropicConfigured,
  textFromMessage,
} from "@/lib/anthropic";
import { brandContextBlock } from "@/lib/brand-profile";
import { requireUser } from "@/lib/dal";
import { signalTypeLabel } from "@/lib/signals";
import { createClient } from "@/lib/supabase/server";
import type { Alert, AlertAnalysis, AlertAlternative } from "@/lib/types/database";

/**
 * "Go deeper" — the second pass over one alert.
 *
 * Every alert already carries one recommended action, written by WF-02 as the
 * signal arrived. This produces the alternatives: other approaches the operator
 * could take, each with what it costs them.
 *
 * On demand, deliberately. Generating three approaches for all thirty-nine alerts
 * a day would produce a hundred-odd instructions nobody reads, at a hundred times
 * the cost — the product's job is to narrow attention, not to manufacture more of
 * it. So this runs when the operator opens an alert and asks, and only then.
 */

export type AnalysisResult =
  | { ok: true; analysis: AlertAnalysis }
  | { ok: false; error: string };

/**
 * The shape Claude must return.
 *
 * `strict`-style: every property required, `additionalProperties: false`. A model
 * that omits `tradeoff` produces an alternative the operator cannot choose
 * between — the tradeoff is the entire reason the alternative is worth showing,
 * so it is required rather than optional.
 */
const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    deeper_impact: {
      type: "string",
      description:
        "Three or four sentences on what this change does to THIS brand specifically — which of their products, which price positions, which customers. Name their categories and figures where the profile gives them. If the brand profile is thin or inferred, say what you are assuming rather than asserting it.",
    },
    alternatives: {
      type: "array",
      minItems: 2,
      description:
        "Genuinely different postures, not three phrasings of one move. If one of them is 'do nothing', include it — holding is often correct and the operator deserves to see it argued rather than omitted. Provide 2–3 alternatives maximum.",
      items: {
        type: "object",
        properties: {
          approach: {
            type: "string",
            description:
              "Two to four words naming the posture. 'Match on price', 'Hold and differentiate', 'Wait for their promo to end'.",
          },
          action: {
            type: "string",
            description:
              "What to actually do, specific enough to start today. Name the lever and the target.",
          },
          tradeoff: {
            type: "string",
            description:
              "What this costs them — margin, positioning, time, optionality. One sentence, concrete. Never 'may not work' or 'carries some risk'.",
          },
        },
        required: ["approach", "action", "tradeoff"],
        additionalProperties: false,
      },
    },
  },
  required: ["deeper_impact", "alternatives"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You advise a single ecommerce/D2C brand on competitor moves.

The reader is the brand owner. They have already seen a one-line summary of this
change and one recommended action. You are the second opinion they asked for when
that was not enough — so do not restate the summary back to them, and do not
repeat the action they have already read.

Give them the alternatives. Each one is a different posture toward the same
situation, and each one costs them something. Naming that cost is the whole job:
an alternative without a stated tradeoff is not a choice, it is a suggestion.

Rules:

- Use the brand's own catalogue, categories and price band when reasoning. If the
  brand profile is marked inferred, say what you are assuming rather than stating
  it as fact.
- Never write "monitor the situation", "consider reviewing", or "evaluate your
  options". If the honest answer is to do nothing, say that plainly and say for
  how long and what would change your mind.
- Give numbers where the data gives you numbers. Never "significant" or
  "substantial" where a figure exists.
- Do not invent customer segments, margins, or sales data. Nothing in this system
  knows the brand's margins unless the operator wrote them in their profile.`;

/** The alert, rendered for the prompt. Only fields the model should reason from. */
function alertContext(alert: Alert): string {
  const lines: string[] = ["<competitor_signal>"];

  lines.push(`Competitor: ${alert.competitor_name}`);
  lines.push(`Type: ${signalTypeLabel(alert.signal_type)}`);
  lines.push(`Severity as rated: ${alert.severity}`);
  lines.push(`Detected: ${alert.created_at}`);
  lines.push("");
  lines.push(`What changed: ${alert.summary}`);

  if (alert.impact) lines.push(`Impact already noted: ${alert.impact}`);
  if (alert.recommended_action) {
    lines.push(`Action already given to the operator: ${alert.recommended_action}`);
  }

  if (alert.product_title) lines.push(`Product: ${alert.product_title}`);
  if (typeof alert.previous_price === "number" && typeof alert.current_price === "number") {
    const unit = alert.currency ? `${alert.currency} ` : "";
    lines.push(
      `Price: ${unit}${alert.previous_price} → ${unit}${alert.current_price}` +
        (typeof alert.delta_pct === "number" ? ` (${alert.delta_pct.toFixed(1)}%)` : ""),
    );
  }

  // Said plainly rather than omitted: an unclassified alert has no severity
  // judgement behind it, and the model should not inherit confidence from a
  // rating that was never made.
  if (!alert.ai_available) {
    lines.push("");
    lines.push(
      "NOTE: automated interpretation failed for this signal. The severity above is a placeholder, not a judgement. Reason from the raw change only.",
    );
  }

  lines.push("</competitor_signal>");
  return lines.join("\n");
}

/**
 * Generate (or regenerate) the deeper analysis for one alert.
 *
 * Upserts on `alert_id` — one analysis per alert, and asking again replaces the
 * old one rather than accumulating stale takes on a competitor move that has
 * since been resolved.
 */
export async function analyzeAlert(alertId: number): Promise<AnalysisResult> {
  await requireUser();

  if (!isAnthropicConfigured()) {
    return {
      ok: false,
      error:
        "Deeper analysis is not set up yet — ANTHROPIC_API_KEY is missing. Alerts and briefings are unaffected.",
    };
  }

  const supabase = await createClient();

  const { data: alertRow, error: alertError } = await supabase
    .from("alerts")
    .select("*")
    .eq("id", alertId)
    .maybeSingle();

  if (alertError) return { ok: false, error: `Could not read that alert: ${alertError.message}` };
  if (!alertRow) return { ok: false, error: "That alert no longer exists." };

  const alert = alertRow as Alert;
  const brandContext = await brandContextBlock();

  let message;
  try {
    message = await anthropic().messages.create({
      model: ANALYSIS_MODEL,
      max_tokens: 16000,
      // Adaptive thinking at high effort. This is the hardest reasoning the app
      // does — weighing a competitor's move against the operator's own catalogue
      // and margins — and it runs a handful of times a day, so depth is cheap
      // here in a way it would not be in the signal pipeline.
      thinking: { type: "adaptive" },
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema: ANALYSIS_SCHEMA },
      },
      // Stable prefix, cached. The brand profile and the alert go in the user
      // message below — both change per request, and volatile content inside a
      // cached prefix invalidates it on every call while appearing to work.
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: `${brandContext}${alertContext(alert)}

Give the deeper impact reading and the alternatives.`,
        },
      ],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return { ok: false, error: `Analysis call failed: ${detail}` };
  }

  const text = textFromMessage(message);
  if (!text.ok) return { ok: false, error: text.error };

  let parsed: { deeper_impact: string; alternatives: AlertAlternative[] };
  try {
    parsed = JSON.parse(text.text);
  } catch {
    // Structured output makes this close to impossible, but a parse failure that
    // silently writes an empty analysis is worse than an error the operator can
    // retry from.
    return { ok: false, error: "Claude's answer did not come back in the expected shape." };
  }

  const { data: saved, error: saveError } = await supabase
    .from("alert_analyses")
    .upsert(
      {
        alert_id: alertId,
        alternatives: parsed.alternatives,
        deeper_impact: parsed.deeper_impact,
        model: ANALYSIS_MODEL,
        usage: {
          input_tokens: message.usage.input_tokens,
          output_tokens: message.usage.output_tokens,
          cache_read_input_tokens: message.usage.cache_read_input_tokens ?? undefined,
          cache_creation_input_tokens: message.usage.cache_creation_input_tokens ?? undefined,
        },
      },
      { onConflict: "alert_id" },
    )
    .select()
    .single();

  if (saveError) {
    return { ok: false, error: `Analysis generated but could not be saved: ${saveError.message}` };
  }

  return { ok: true, analysis: saved as AlertAnalysis };
}

/** Read an existing analysis without generating one. Null when never requested. */
export async function readAlertAnalysis(alertId: number): Promise<AlertAnalysis | null> {
  await requireUser();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("alert_analyses")
    .select("*")
    .eq("alert_id", alertId)
    .maybeSingle();

  if (error) {
    console.error("[analysis] read failed:", error.message);
    return null;
  }
  return (data as AlertAnalysis | null) ?? null;
}
