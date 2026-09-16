"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ChatTarget } from "@/components/chat-provider";

/**
 * The chat slide-over.
 *
 * Sits beside the evidence rather than over it. The entire reason the detail
 * pane exists is that a recommendation without its proof gets ignored; a panel
 * that covers the proof while you ask about it undoes that. On a narrow viewport
 * there is no room for both, so it takes the screen.
 *
 * Wire format is NDJSON from /api/chat — one JSON object per line. See the route
 * handler for why: the reply is streamed, and a frame type distinguishes the
 * model's thinking from its answer so a long pause reads as progress instead of
 * a hang.
 */

interface Turn {
  role: "user" | "assistant";
  content: string;
  /** True while this turn is still arriving. */
  streaming?: boolean;
}

export function ChatPanel({ target, onClose }: { target: ChatTarget; onClose: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [thinking, setThinking] = useState("");
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conversationId = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // Escape closes. A slide-over you can only dismiss with the mouse is a small
  // cruelty on a keyboard-driven triage screen.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [turns, thinking]);

  const send = useCallback(
    async (message: string) => {
      const text = message.trim();
      if (!text || pending) return;

      setDraft("");
      setError(null);
      setPending(true);
      setThinking("");
      setTurns((prev) => [
        ...prev,
        { role: "user", content: text },
        { role: "assistant", content: "", streaming: true },
      ]);

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            conversationId: conversationId.current,
            alertId: target.alertId,
            digestId: target.digestId,
            anchor: target.anchor,
          }),
        });

        if (!response.ok || !response.body) {
          const detail = await response.json().catch(() => null);
          throw new Error(detail?.error ?? `Chat failed (${response.status}).`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        // Frames are newline-delimited, and a chunk boundary can land anywhere —
        // including mid-frame. Keep the remainder in the buffer rather than
        // parsing whatever arrived, or roughly one reply in ten dies on a
        // truncated JSON line.
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.trim()) continue;
            let frame: Record<string, unknown>;
            try {
              frame = JSON.parse(line);
            } catch {
              continue;
            }

            if (frame.type === "conversation" && typeof frame.id === "string") {
              conversationId.current = frame.id;
            } else if (frame.type === "thinking" && typeof frame.text === "string") {
              setThinking((prev) => prev + frame.text);
            } else if (frame.type === "text" && typeof frame.text === "string") {
              setThinking("");
              setTurns((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last?.role === "assistant") {
                  next[next.length - 1] = { ...last, content: last.content + frame.text };
                }
                return next;
              });
            } else if (frame.type === "error" && typeof frame.message === "string") {
              setError(frame.message);
            }
          }
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Chat failed.");
      } finally {
        setThinking("");
        setPending(false);
        setTurns((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === "assistant") next[next.length - 1] = { ...last, streaming: false };
          // A reply that produced nothing leaves an empty bubble, which reads as
          // the model having said nothing rather than as a failure. Drop it and
          // let the error line carry the message.
          return next[next.length - 1]?.content ? next : next.slice(0, -1);
        });
      }
    },
    [pending, target],
  );

  const suggestions = target.suggestions ?? [];

  return (
    <div className="fixed inset-0 z-50 flex justify-end md:inset-y-0 md:left-auto">
      {/* Dim on narrow only — on a wide screen the evidence must stay readable. */}
      <button
        type="button"
        aria-label="Close chat"
        onClick={onClose}
        className="absolute inset-0 bg-ink/20 md:hidden"
      />

      <aside className="relative flex h-full w-full flex-col border-l border-border bg-surface shadow-[var(--shadow-raised)] md:w-[420px]">
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <p className="eyebrow">Discussing</p>
            <p className="mt-1 truncate text-base font-semibold text-ink">{target.subject}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-surface-sunken hover:text-ink"
          >
            <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="m4 4 8 8M12 4l-8 8" />
            </svg>
            <span className="sr-only">Close</span>
          </button>
        </header>

        <div ref={scroller} className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
          {turns.length === 0 ? (
            <div className="space-y-3">
              <p className="text-base text-ink-muted">
                Ask about this change and what it means for your business. The alert, your
                catalogue and the options on screen are already in context.
              </p>
              {suggestions.length ? (
                <div className="space-y-2">
                  <p className="eyebrow">Try asking</p>
                  {suggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => void send(suggestion)}
                      className="block w-full rounded-lg border border-dashed border-border-strong px-3 py-2 text-left text-base
                                 text-ink-muted transition-colors hover:border-accent hover:bg-accent-wash hover:text-ink"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {turns.map((turn, index) => (
            <div
              key={index}
              className={
                turn.role === "user"
                  ? "ml-auto max-w-[85%] rounded-xl rounded-br-sm bg-accent-wash px-3.5 py-2.5 text-base text-ink"
                  : "max-w-full text-base leading-relaxed text-ink"
              }
            >
              {turn.content}
              {turn.streaming && turn.content ? (
                <span aria-hidden className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-accent align-text-bottom" />
              ) : null}
            </div>
          ))}

          {/* Summarised reasoning, streamed. Without it Opus 5 looks hung for
              several seconds before the first word of the answer appears. */}
          {thinking ? (
            <p className="border-l-2 border-border pl-3 text-sm italic leading-relaxed text-ink-faint">
              {thinking}
            </p>
          ) : null}

          {pending && !thinking && !turns[turns.length - 1]?.content ? (
            <p className="text-sm text-ink-faint">Reading the evidence…</p>
          ) : null}

          {error ? (
            <p role="alert" className="rounded-lg bg-sev-critical-wash px-3 py-2 text-base text-sev-critical">
              {error}
            </p>
          ) : null}
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send(draft);
          }}
          className="flex items-end gap-2 border-t border-border px-4 py-3"
        >
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter breaks the line — the convention
              // everywhere else the operator types.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send(draft);
              }
            }}
            rows={1}
            placeholder="Ask a follow-up…"
            className="max-h-32 min-h-[40px] flex-1 resize-y rounded-lg border border-border bg-surface-sunken px-3 py-2 text-base
                       text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
          <button
            type="submit"
            disabled={pending || !draft.trim()}
            className="rounded-lg bg-solid px-3.5 py-2 text-base font-medium text-solid-ink transition-colors
                       hover:bg-solid-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            Send
          </button>
        </form>
      </aside>
    </div>
  );
}
