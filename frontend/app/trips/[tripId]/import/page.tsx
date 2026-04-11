"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTripContext } from "@/app/trips/[tripId]/layout";
import { ChatMessages } from "@/components/chat/chat-messages";
import {
  BuildProgress,
  type BuildAction,
} from "@/components/dag/build-progress";
import { api } from "@/lib/api";

const MAX_INPUT_LENGTH = 10_000;

interface Note {
  category: string;
  content: string;
  confidence: string;
}

interface Message {
  role: string;
  content: string;
}

interface ChatResponse {
  reply: { role: string; content: string };
  notes: Note[];
  ready_to_build: boolean;
}

interface BuildResponse {
  plan_id: string;
  summary: string;
  nodes_created: number;
  edges_created: number;
  actions_taken: BuildAction[];
}

export default function ImportPage() {
  const { tripId, trip, refetch } = useTripContext();
  const router = useRouter();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [readyToBuild, setReadyToBuild] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [building, setBuilding] = useState(false);
  const [buildActions, setBuildActions] = useState<BuildAction[]>([]);
  const [buildPhase, setBuildPhase] = useState<
    "preparing" | "nodes" | "edges" | "verifying" | "complete"
  >("preparing");
  const [error, setError] = useState<string | null>(null);

  async function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || sending) return;

    if (trimmed.length > MAX_INPUT_LENGTH) {
      setError(
        `Input must be under ${MAX_INPUT_LENGTH.toLocaleString()} characters`,
      );
      return;
    }

    const userMessage: Message = { role: "user", content: trimmed };
    const updatedMessages = [...messages, userMessage];

    setMessages(updatedMessages);
    setInput("");
    setSending(true);
    setError(null);

    try {
      const data = await api.post<ChatResponse>(
        `/trips/${tripId}/import/chat`,
        { messages: updatedMessages },
      );

      setMessages([...updatedMessages, data.reply]);
      setNotes(data.notes);
      setReadyToBuild(data.ready_to_build);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send your message — please try again.");
    } finally {
      setSending(false);
    }
  }

  async function handleBuild() {
    setBuilding(true);
    setBuildActions([]);
    setBuildPhase("preparing");
    setError(null);

    try {
      const data = await api.post<BuildResponse>(
        `/trips/${tripId}/import/build`,
        { messages },
      );

      // Replay actions with staggered delays for animation
      const actions = data.actions_taken;
      let currentPhase: typeof buildPhase = "preparing";

      for (let i = 0; i < actions.length; i++) {
        const action = actions[i];

        // Determine phase from action type
        if (action.type === "node_added" && currentPhase !== "nodes") {
          currentPhase = "nodes";
          setBuildPhase("nodes");
        } else if (action.type === "edge_added" && currentPhase !== "edges") {
          currentPhase = "edges";
          setBuildPhase("edges");
        }

        // Stagger each action for visual effect
        await new Promise((r) => setTimeout(r, 300));
        setBuildActions((prev) => [...prev, action]);
      }

      // Verification phase
      setBuildPhase("verifying");
      await new Promise((r) => setTimeout(r, 1500));

      // Complete
      setBuildPhase("complete");
      await new Promise((r) => setTimeout(r, 1200));

      refetch();
      router.push(`/trips/${tripId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't build the trip — please try again.");
      setBuilding(false);
    }
  }

  async function handleSkip() {
    const skipMessage: Message = {
      role: "user",
      content: "Skip questions and build the trip with what you have.",
    };
    const updatedMessages = [...messages, skipMessage];

    setMessages(updatedMessages);
    setSending(true);
    setError(null);

    try {
      const data = await api.post<ChatResponse>(
        `/trips/${tripId}/import/chat`,
        { messages: updatedMessages },
      );

      setMessages([...updatedMessages, data.reply]);
      setNotes(data.notes);
      setReadyToBuild(data.ready_to_build);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send — please try again.");
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // Full-screen build progress view
  if (building) {
    return (
      <div className="flex flex-col flex-1 bg-surface">
        <header className="flex items-center gap-3 px-5 py-4 bg-surface-lowest">
          <div>
            <h1 className="text-base font-bold text-on-surface">
              Building your trip...
            </h1>
            <p className="text-xs text-on-surface-variant">{trip?.name}</p>
          </div>
        </header>
        <BuildProgress
          actions={buildActions}
          phase={buildPhase}
          error={error}
          onRetry={handleBuild}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 bg-surface">
      {/* Header */}
      <header className="flex items-center gap-3 px-5 py-4 bg-surface-lowest">
        <button
          onClick={() => router.back()}
          className="h-10 w-10 rounded-full bg-surface-low flex items-center justify-center text-on-surface-variant transition-colors active:bg-surface-container"
        >
          <svg
            className="h-5 w-5"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15.75 19.5 8.25 12l7.5-7.5"
            />
          </svg>
        </button>
        <div>
          <h1 className="text-base font-bold text-on-surface">Magic Import</h1>
          <p className="text-xs text-on-surface-variant">{trip?.name}</p>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-5 py-6">
        {messages.length === 0 ? (
          <div className="text-center py-16 px-4">
            <div className="w-16 h-16 rounded-2xl gradient-primary flex items-center justify-center mx-auto mb-5 shadow-ambient">
              <svg
                className="h-8 w-8 text-on-primary"
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
            <h2 className="text-xl font-bold text-on-surface mb-2">
              Tell us about your trip
            </h2>
            <p className="text-sm text-on-surface-variant leading-relaxed">
              Paste your group chat, travel notes, or just describe the trip.
              <br />
              The AI will turn it into a full itinerary.
            </p>
          </div>
        ) : (
          <ChatMessages messages={messages} notes={notes} loading={sending} />
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="px-5 py-3 bg-error-container/15">
          <p className="text-sm text-error">{error}</p>
        </div>
      )}

      {/* Build CTA */}
      {readyToBuild && !building && (
        <div className="px-5 py-4 bg-secondary/5">
          <p className="text-sm text-secondary font-medium mb-3 text-center">
            Ready to build your trip!
          </p>
          <button
            onClick={handleBuild}
            className="w-full rounded-2xl bg-secondary py-3.5 text-base font-semibold text-on-secondary shadow-ambient transition-all active:scale-[0.98]"
          >
            Build Trip
          </button>
        </div>
      )}

      {/* Input */}
      <div className="bg-surface-lowest px-5 py-4">
        <div className="flex gap-3 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              messages.length === 0
                ? "Paste your itinerary or travel plans..."
                : "Type a reply..."
            }
            rows={messages.length === 0 ? 4 : 1}
            maxLength={MAX_INPUT_LENGTH}
            disabled={sending || building}
            className="flex-1 resize-none rounded-2xl bg-surface-high px-4 py-3 text-sm text-on-surface placeholder:text-outline focus:outline-none focus:ring-2 focus:ring-primary/30 transition-shadow disabled:opacity-50"
          />
          <div className="flex flex-col gap-1.5">
            <button
              onClick={handleSend}
              disabled={!input.trim() || sending || building}
              className="h-11 w-11 rounded-full gradient-primary flex items-center justify-center text-on-primary shadow-soft transition-all active:scale-95 disabled:opacity-40"
            >
              <svg
                className="h-5 w-5"
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
            {messages.length > 0 && !readyToBuild && (
              <button
                onClick={handleSkip}
                disabled={sending || building}
                className="text-xs text-on-surface-variant hover:text-primary font-medium"
              >
                Skip
              </button>
            )}
          </div>
        </div>
        {input.length > MAX_INPUT_LENGTH * 0.9 && (
          <p className="text-xs text-outline mt-2">
            {input.length.toLocaleString()} /{" "}
            {MAX_INPUT_LENGTH.toLocaleString()}
          </p>
        )}
      </div>
    </div>
  );
}
