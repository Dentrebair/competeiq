import { CHAT_MODEL, anthropic, isAnthropicConfigured } from "@/lib/anthropic";
import { brandContextBlock } from "@/lib/brand-profile";
import { requireUserOrRespond } from "@/lib/dal";
import { signalTypeLabel } from "@/lib/signals";
import { createClient } from "@/lib/supabase/server";
import type {
  Alert,
  AlertAnalysis,
  Conversation,
  Digest,
  Message,
} from "@/lib/types/database";

/**
 * Chat, anchored to one alert or one briefing.
 *
 * A Route Handler rather than a Server Action because this streams. Actions
 * return a value once; a chat reply that arrives all at once after eight seconds
 * of nothing reads as broken, however good the answer is.
 *
 * This is one of the two places the app calls Claude directly — see lib/anthropic.ts
 * for why that exception exists. Everything automated still runs in n8n.
 *
 * Scope is deliberate and enforced below: every conversation is attached to an
 * alert or a digest. There is no general assistant. An unanchored chat has no
 * evidence to reason from and degrades into generic marketing advice, which is
 * the thing this product exists to replace.
 */

/** Bounds. All three are about cost and coherence, not security. */
const MAX_MESSAGE_CHARS = 4000;
/** Older turns are dropped from context. Anchored chats do not run long. */
const MAX_HISTORY_MESSAGES = 40;
const MAX_REPLY_TOKENS = 8000;

const SYSTEM_PROMPT = `You are advising the owner of a single ecommerce/D2C brand about one specific competitor signal.

The evidence is on screen next to you: what changed, what it means, and what was
recommended. The owner opened this conversation because they want to think it
through, not because they want the summary repeated.

How to answer:

- Answer the question actually asked. Do not restate the alert.
- Reason from THEIR catalogue, categories and price band — that is what makes this
  worth more than generic advice. Where their profile is marked inferred, say what
  you are assuming.
- Be concrete. Name the SKU, the price, the week. Where a number exists, use it
  instead of "significant" or "substantial".
- Short. Two or three paragraphs at most unless they ask for depth. They are
  making a decision, not reading a report.
- When the honest answer is that the data does not support a conclusion, say so
  and say what would settle it. Never fill the gap with a plausible guess.
- Never invent margins, customer segments, or sales figures. Nothing in this
  system knows those unless the owner told you.
- Stay on this signal and what follows from it. If asked about something
  unrelated, say that this conversation is attached to a specific alert and offer
  to help with what it does cover.`;

type Frame =
  | { type: "conversation"; id: string }
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "done"; truncated: boolean }
  | { type: "error"; message: string };

function encodeFrame(frame: Frame): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(frame)}\n`);
}

/** A short, readable name for the thread, from the operator's first question. */
function titleFrom(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

/** The alert, its analysis if one exists, rendered as grounding. */
function alertContext(alert: Alert, analysis: AlertAnalysis | null): string {
  const lines: string[] = ["<competitor_signal>"];

  lines.push(`Competitor: ${alert.competitor_name}`);
  lines.push(`Type: ${signalTypeLabel(alert.signal_type)}`);
  lines.push(`Severity: ${alert.severity}`);
  lines.push(`Detected: ${alert.created_at}`);
  lines.push("");
  lines.push(`What changed: ${alert.summary}`);

  if (alert.impact) lines.push(`Impact: ${alert.impact}`);
  if (alert.recommended_action) lines.push(`Recommended: ${alert.recommended_action}`);
  if (alert.product_title) lines.push(`Product: ${alert.product_title}`);

  if (typeof alert.previous_price === "number" && typeof alert.current_price === "number") {
    const unit = alert.currency ? `${alert.currency} ` : "";
    lines.push(
      `Price: ${unit}${alert.previous_price} → ${unit}${alert.current_price}` +
        (typeof alert.delta_pct === "number" ? ` (${alert.delta_pct.toFixed(1)}%)` : ""),
    );
  }

  if (!alert.ai_available) {
    lines.push("");
    lines.push(
      "NOTE: automated interpretation failed for this signal, so the severity above is a placeholder rather than a judgement. Reason from the raw change.",
    );
  }

  if (analysis) {
    lines.push("");
    if (analysis.deeper_impact) lines.push(`Deeper reading: ${analysis.deeper_impact}`);
    if (analysis.alternatives.length) {
      lines.push("Alternatives already shown to the owner:");
      for (const alt of analysis.alternatives) {
        lines.push(`- ${alt.approach}: ${alt.action} (tradeoff: ${alt.tradeoff})`);
      }
    }
  }

  lines.push("</competitor_signal>");
  return lines.join("\n");
}

/** The briefing's headline and priority action, for a digest-anchored thread. */
function digestContext(digest: Digest): string {
  const lines: string[] = ["<briefing>"];
  if (digest.headline) lines.push(`Headline: ${digest.headline}`);
  if (digest.priority_action) {
    lines.push(`Priority action: ${digest.priority_action.action}`);
    lines.push(`Why now: ${digest.priority_action.why_now}`);
    lines.push(`Competitor: ${digest.priority_action.competitor}`);
  }
  if (digest.patterns?.length) {
    lines.push("Patterns:");
    for (const pattern of digest.patterns) {
      lines.push(`- ${pattern.pattern}`);
    }
  }
  if (digest.quiet_competitors?.length) {
    lines.push(`Quiet: ${digest.quiet_competitors.join(", ")}`);
  }
  lines.push("</briefing>");
  return lines.join("\n");
}

interface ChatRequest {
  message?: unknown;
  conversationId?: unknown;
  alertId?: unknown;
  digestId?: unknown;
  anchor?: unknown;
}

export async function POST(request: Request) {
  const unauthorized = await requireUserOrRespond();
  if (unauthorized) return unauthorized;

  if (!isAnthropicConfigured()) {
    return Response.json(
      {
        error:
          "Chat is not set up yet — ANTHROPIC_API_KEY is missing. Alerts and briefings are unaffected.",
      },
      { status: 503 },
    );
  }

  let body: ChatRequest;
  try {
    body = (await request.json()) as ChatRequest;
  } catch {
    return Response.json({ error: "Malformed request body." }, { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return Response.json({ error: "Message is empty." }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return Response.json(
      { error: `Message is too long — keep it under ${MAX_MESSAGE_CHARS} characters.` },
      { status: 400 },
    );
  }

  const conversationId = typeof body.conversationId === "string" ? body.conversationId : null;
  const alertId = typeof body.alertId === "number" ? body.alertId : null;
  const digestId = typeof body.digestId === "string" ? body.digestId : null;
  const anchor = typeof body.anchor === "string" ? body.anchor : null;

  const supabase = await createClient();

  // ---- Resolve the conversation -------------------------------------------
  //
  // Either continuing an existing thread or opening a new one. A new thread must
  // name what it is about; the CHECK constraint in 05 enforces that too, but
  // failing here gives a better message than a constraint violation would.

  let conversation: Conversation;

  if (conversationId) {
    const { data, error } = await supabase
      .from("conversations")
      .select("*")
      .eq("id", conversationId)
      .maybeSingle();

    if (error) return Response.json({ error: error.message }, { status: 500 });
    if (!data) return Response.json({ error: "That conversation no longer exists." }, { status: 404 });
    conversation = data as Conversation;
  } else {
    if (alertId === null && digestId === null) {
      return Response.json(
        {
          error:
            "A conversation has to be about something — open it from an alert or the briefing.",
        },
        { status: 400 },
      );
    }

    const { data, error } = await supabase
      .from("conversations")
      .insert({
        alert_id: alertId,
        digest_id: digestId,
        anchor,
        title: titleFrom(message),
      })
      .select()
      .single();

    if (error) return Response.json({ error: error.message }, { status: 500 });
    conversation = data as Conversation;
  }

  // ---- Gather grounding ----------------------------------------------------

  const [historyResult, brandContext] = await Promise.all([
    supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: true })
      .limit(MAX_HISTORY_MESSAGES),
    brandContextBlock(),
  ]);

  const history = (historyResult.data ?? []) as Message[];

  let evidence = "";
  if (conversation.alert_id !== null) {
    const [alertResult, analysisResult] = await Promise.all([
      supabase.from("alerts").select("*").eq("id", conversation.alert_id).maybeSingle(),
      supabase
        .from("alert_analyses")
        .select("*")
        .eq("alert_id", conversation.alert_id)
        .maybeSingle(),
    ]);
    if (alertResult.data) {
      evidence = alertContext(
        alertResult.data as Alert,
        (analysisResult.data as AlertAnalysis | null) ?? null,
      );
    }
  } else if (conversation.digest_id) {
    const { data } = await supabase
      .from("digests")
      .select("*")
      .eq("id", conversation.digest_id)
      .maybeSingle();
    if (data) evidence = digestContext(data as Digest);
  }

  // The anchor row is gone — deleted alert, reaped digest. Refuse rather than
  // answer from nothing: an ungrounded reply is exactly the failure this design
  // is meant to prevent.
  if (!evidence) {
    return Response.json(
      { error: "The alert this conversation was about is no longer available." },
      { status: 409 },
    );
  }

  // ---- Record the question before answering it ----------------------------
  //
  // Written first on purpose. If the model call fails or the operator closes the
  // tab mid-reply, what they asked is still in the transcript — a thread that
  // silently loses the question is worse than one with an unanswered question.

  const { error: userInsertError } = await supabase.from("messages").insert({
    conversation_id: conversation.id,
    role: "user",
    content: message,
  });

  if (userInsertError) {
    return Response.json({ error: userInsertError.message }, { status: 500 });
  }

  const turns = [
    ...history.map((row) => ({ role: row.role, content: row.content })),
    { role: "user" as const, content: message },
  ];

  // ---- Stream --------------------------------------------------------------

  let assistantText = "";
  let persisted = false;

  /**
   * Save whatever was generated, exactly once.
   *
   * Called on completion, on error, and on client disconnect. A reply that was
   * cut short is marked as such: without the flag, a dropped connection is
   * indistinguishable in the transcript from Claude trailing off mid-sentence,
   * and the record stops being trustworthy.
   */
  async function persist(truncated: boolean) {
    if (persisted || !assistantText.trim()) return;
    persisted = true;
    const { error } = await supabase.from("messages").insert({
      conversation_id: conversation.id,
      role: "assistant",
      content: assistantText,
      truncated,
    });
    if (error) console.error("[chat] could not save reply:", error.message);
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encodeFrame({ type: "conversation", id: conversation.id }));

      try {
        const claude = anthropic().messages.stream({
          model: CHAT_MODEL,
          max_tokens: MAX_REPLY_TOKENS,
          // `summarized` rather than the default. Opus 5 thinks before answering,
          // and with thinking omitted the operator watches an empty panel for
          // several seconds with no indication anything is happening. Streaming
          // the summary turns a dead pause into visible progress.
          thinking: { type: "adaptive", display: "summarized" },
          // Medium, not high: this is an interactive turn where latency is part
          // of the answer's quality. The deep reasoning happens in "Go deeper",
          // which is allowed to take its time.
          output_config: { effort: "medium" },
          system: [
            // Stable prefix — cached. Everything volatile is in the second block
            // and in the messages, both after the breakpoint.
            { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
            { type: "text", text: `${brandContext}${evidence}` },
          ],
          messages: turns,
        });

        for await (const event of claude) {
          if (event.type !== "content_block_delta") continue;

          if (event.delta.type === "text_delta") {
            assistantText += event.delta.text;
            controller.enqueue(encodeFrame({ type: "text", text: event.delta.text }));
          } else if (event.delta.type === "thinking_delta") {
            controller.enqueue(encodeFrame({ type: "thinking", text: event.delta.thinking }));
          }
        }

        const final = await claude.finalMessage();

        if (final.stop_reason === "refusal") {
          controller.enqueue(
            encodeFrame({
              type: "error",
              message: "Claude declined to answer that one.",
            }),
          );
        }

        const truncated = final.stop_reason === "max_tokens";
        await persist(truncated);
        controller.enqueue(encodeFrame({ type: "done", truncated }));
      } catch (error) {
        // Keep the partial reply — half an answer plus an honest error beats
        // losing both.
        await persist(true);
        const detail = error instanceof Error ? error.message : "unknown error";
        controller.enqueue(encodeFrame({ type: "error", message: detail }));
      } finally {
        controller.close();
      }
    },

    /** The operator navigated away or closed the panel mid-reply. */
    async cancel() {
      await persist(true);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      // Streaming through a proxy that buffers defeats the entire point.
      "X-Accel-Buffering": "no",
    },
  });
}
