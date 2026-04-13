"use client";

import { useRef, useEffect, useState } from "react";
import { ActionBadges } from "@/components/chat/action-badges";
import { MarkdownContent } from "@/components/chat/markdown-content";
import { api } from "@/lib/api";

interface ActionTaken {
  type: string;
  node_id: string | null;
  description: string;
}

interface ExtractedPreference {
  content: string;
  category: string;
}

interface AgentChatResponse {
  reply: string;
  is_new_session: boolean;
  actions_taken: ActionTaken[];
  preferences_extracted: ExtractedPreference[];
}

interface ChatEntry {
  role: "user" | "assistant";
  content: string;
  actions_taken?: ActionTaken[];
  preferences_extracted?: ExtractedPreference[];
}

interface AgentOverlayProps {
  tripId: string;
  tripName?: string;
  planId: string | null;
  open: boolean;
  onClose: () => void;
}

export function AgentOverlay({
  tripId,
  tripName,
  planId,
  open,
  onClose,
}: AgentOverlayProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isNewSession, setIsNewSession] = useState(true);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!open || loadedRef.current) return;
    loadedRef.current = true;
    let cancelled = false;
    api
      .get<{
        messages: { role: string; content: string }[];
        is_new_session: boolean;
      }>(`/trips/${tripId}/agent/history`)
      .then((data) => {
        if (cancelled) return;
        if (data.messages.length > 0) {
          setMessages(
            data.messages.map((m) => ({
              role: m.role as "user" | "assistant",
              content: m.content,
            })),
          );
        }
        setIsNewSession(data.is_new_session);
      })
      .catch(() => { })
      .finally(() => {
        if (!cancelled) setLoadingHistory(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tripId, open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, sending]);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 200);
    }
  }, [open]);

  async function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || sending) return;

    const userEntry: ChatEntry = { role: "user", content: trimmed };
    setMessages((prev) => [...prev, userEntry]);
    setInput("");
    setSending(true);
    setError(null);

    try {
      const data = await api.post<AgentChatResponse>(
        `/trips/${tripId}/agent/chat`,
        { message: trimmed, plan_id: planId },
      );

      const assistantEntry: ChatEntry = {
        role: "assistant",
        content: data.reply,
        actions_taken: data.actions_taken,
        preferences_extracted: data.preferences_extracted,
      };

      setMessages((prev) => [...prev, assistantEntry]);
      setIsNewSession(data.is_new_session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send — please try again.");
    } finally {
      setSending(false);
    }
  }

  async function handleNewChat() {
    try {
      await api.delete(`/trips/${tripId}/agent/history`);
    } catch {
      // best-effort
    }
    setMessages([]);
    setIsNewSession(true);
    setError(null);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-surface/95 backdrop-blur-sm animate-fade-in">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 bg-surface-lowest shadow-soft">
        <button
          onClick={onClose}
          className="h-9 w-9 rounded-full bg-surface-low flex items-center justify-center text-on-surface-variant transition-colors active:bg-surface-container"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2.5}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M6 18 18 6M6 6l12 12"
            />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-bold text-on-surface">Trip Buddy</h2>
          {tripName && (
            <p className="text-[11px] text-on-surface-variant truncate">
              {tripName}
            </p>
          )}
        </div>
        <button
          onClick={handleNewChat}
          disabled={sending || messages.length === 0}
          className="rounded-full bg-surface-high px-3 py-1.5 text-xs font-semibold text-on-surface-variant transition-all active:scale-95 disabled:opacity-30"
        >
          New Chat
        </button>
      </header>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        {loadingHistory ? (
          <div className="flex justify-center py-12">
            <div className="h-7 w-7 animate-spin rounded-full border-3 border-surface-high border-t-primary" />
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center py-12 px-4">
            <div className="w-14 h-14 rounded-2xl gradient-primary flex items-center justify-center mx-auto mb-4 shadow-ambient">
              <svg
                className="h-7 w-7 text-on-primary"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z"
                />
              </svg>
            </div>
            <h3 className="text-lg font-bold text-on-surface mb-1.5">
              Trip Buddy
            </h3>
            <p className="text-xs text-on-surface-variant leading-relaxed">
              Add stops, change dates, search for places,
              <br />
              or research destinations.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {messages.map((msg, i) => (
              <div key={i}>
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${msg.role === "user"
                    ? "self-end ml-auto gradient-primary text-on-primary"
                    : "self-start bg-surface-lowest text-on-surface shadow-soft"
                    }`}
                >
                  {msg.role === "user" ? (
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                  ) : (
                    <MarkdownContent content={msg.content} />
                  )}
                </div>
                {msg.actions_taken && msg.actions_taken.length > 0 && (
                  <div className="max-w-[85%]">
                    <ActionBadges
                      actions={msg.actions_taken.filter(
                        (a) => a.type !== "cascade_applied",
                      )}
                    />
                  </div>
                )}
                {msg.preferences_extracted &&
                  msg.preferences_extracted.length > 0 && (
                    <div className="max-w-[85%] mt-1">
                      <div className="flex flex-wrap gap-1">
                        {msg.preferences_extracted.map((pref, j) => (
                          <span
                            key={j}
                            className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-error/10 text-error"
                          >
                            {pref.category}: {pref.content}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
              </div>
            ))}
            {sending && (
              <div className="self-start max-w-[85%] rounded-2xl bg-surface-lowest px-4 py-2.5 text-sm text-on-surface-variant shadow-soft">
                <div className="flex items-center gap-2">
                  <div className="flex gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce [animation-delay:0ms]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce [animation-delay:150ms]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce [animation-delay:300ms]" />
                  </div>
                  <span>Thinking...</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="px-4 py-2 bg-error-container/15">
          <p className="text-sm text-error">{error}</p>
        </div>
      )}

      {/* Input */}
      <div className="bg-surface-lowest px-4 py-3">
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask the agent..."
            rows={1}
            disabled={sending}
            className="flex-1 resize-none rounded-2xl bg-surface-high px-4 py-2.5 text-sm text-on-surface placeholder:text-outline focus:outline-none focus:ring-2 focus:ring-primary/30 transition-shadow disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || sending}
            className="h-10 w-10 rounded-full gradient-primary flex items-center justify-center text-on-primary shadow-soft transition-all active:scale-95 disabled:opacity-40"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
