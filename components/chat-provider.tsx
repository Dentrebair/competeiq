"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { ChatPanel } from "@/components/chat-panel";

/**
 * One chat panel for the whole console.
 *
 * `Discuss` appears beside the impact line, beside every alternative, and on
 * three different screens. Giving each of those its own panel component would
 * mean several could open at once, each with its own scroll position and its own
 * half-finished question. So there is exactly one, and anything that wants it
 * calls `openChat`.
 *
 * Every conversation is anchored to an alert or a briefing — the context type
 * below has no shape for an unanchored chat, which is the point. An unanchored
 * chat has no evidence to reason from and degrades into generic advice.
 */

export interface ChatTarget {
  alertId?: number;
  digestId?: string;
  /** Where on the screen it was opened from — 'impact', 'alternative', … */
  anchor: string;
  /** Named in the panel header so it is obvious what is being discussed. */
  subject: string;
  /** Two or three starter questions. Never open an empty box. */
  suggestions?: string[];
}

interface ChatContextValue {
  openChat: (target: ChatTarget) => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function useChat(): ChatContextValue {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error("useChat must be used inside <ChatProvider>. It wraps the (app) layout.");
  }
  return context;
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<ChatTarget | null>(null);

  const openChat = useCallback((next: ChatTarget) => setTarget(next), []);
  const value = useMemo(() => ({ openChat }), [openChat]);

  return (
    <ChatContext.Provider value={value}>
      {children}
      {target ? <ChatPanel target={target} onClose={() => setTarget(null)} /> : null}
    </ChatContext.Provider>
  );
}
