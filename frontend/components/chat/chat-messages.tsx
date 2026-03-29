"use client";

interface Note {
  category: string;
  content: string;
  confidence: string;
}

interface Message {
  role: string;
  content: string;
}

interface ChatMessagesProps {
  messages: Message[];
  notes: Note[];
  loading?: boolean;
}

const CATEGORY_COLORS: Record<string, string> = {
  destination: "bg-primary/10 text-primary",
  timing: "bg-tertiary-container/30 text-on-tertiary-container",
  activity: "bg-secondary/10 text-secondary",
  budget: "bg-[#7c4dff]/10 text-[#5e35b1]",
  preference: "bg-error/10 text-error",
  accommodation: "bg-primary-container/20 text-on-primary-container",
  branching: "bg-surface-variant text-on-surface-variant",
};

export function ChatMessages({ messages, notes, loading }: ChatMessagesProps) {
  return (
    <div className="flex flex-col gap-3">
      {messages.map((msg, i) => (
        <div
          key={i}
          className={`max-w-[85%] rounded-3xl px-5 py-3 text-sm leading-relaxed ${
            msg.role === "user"
              ? "self-end gradient-primary text-on-primary"
              : "self-start bg-surface-lowest text-on-surface shadow-soft"
          }`}
        >
          <p className="whitespace-pre-wrap">{msg.content}</p>
        </div>
      ))}

      {notes.length > 0 && (
        <div className="self-start max-w-[85%]">
          <p className="text-xs text-on-surface-variant font-medium mb-2">
            Extracted notes
          </p>
          <div className="flex flex-wrap gap-1.5">
            {notes.map((note, i) => (
              <span
                key={i}
                className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${
                  CATEGORY_COLORS[note.category] ||
                  "bg-surface-high text-on-surface-variant"
                }`}
              >
                {note.content}
              </span>
            ))}
          </div>
        </div>
      )}

      {loading && (
        <div className="self-start max-w-[85%] rounded-3xl bg-surface-lowest px-5 py-3 text-sm text-on-surface-variant shadow-soft">
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
  );
}
