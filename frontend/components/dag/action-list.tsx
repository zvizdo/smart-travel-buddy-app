"use client";

import { useEffect, useState } from "react";
import { type DocumentData } from "firebase/firestore";

export type ActionTab = "note" | "todo" | "place";

interface ActionListProps {
  actions: DocumentData[];
  loading?: boolean;
  onToggle?: (actionId: string, isCompleted: boolean) => void | Promise<void>;
  onDelete?: (actionId: string) => void;
  onTabChange?: (tab: ActionTab) => void;
}

export function ActionList({
  actions,
  loading,
  onToggle,
  onDelete,
  onTabChange,
}: ActionListProps) {
  const notes = actions.filter((a) => a.type === "note");
  const todos = actions.filter((a) => a.type === "todo");
  const places = actions.filter((a) => a.type === "place");

  const defaultTab: ActionTab =
    notes.length > 0 ? "note" : todos.length > 0 ? "todo" : "place";
  const [activeTab, setActiveTab] = useState<ActionTab>(defaultTab);

  function selectTab(tab: ActionTab) {
    setActiveTab(tab);
    onTabChange?.(tab);
  }

  if (loading) {
    return (
      <div className="py-2">
        <p className="text-xs text-on-surface-variant">Loading...</p>
      </div>
    );
  }

  if (actions.length === 0) return null;

  const tabs: {
    key: ActionTab;
    label: string;
    count: number;
    icon: React.ReactNode;
  }[] = [
    { key: "note", label: "Notes", count: notes.length, icon: <NoteIcon /> },
    { key: "todo", label: "Todos", count: todos.length, icon: <TodoIcon /> },
    { key: "place", label: "Places", count: places.length, icon: <PinIcon /> },
  ];

  const visibleTabs = tabs.filter((t) => t.count > 0);
  if (visibleTabs.length === 0) return null;

  const effectiveTab =
    visibleTabs.find((t) => t.key === activeTab)
      ? activeTab
      : visibleTabs[0].key;

  return (
    <div className="space-y-3">
      {/* Segmented tab bar */}
      <div className="flex gap-1.5 p-1 rounded-full bg-surface-low">
        {visibleTabs.map((tab) => {
          const active = effectiveTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => selectTab(tab.key)}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-all ${
                active
                  ? "bg-surface-lowest text-primary shadow-sm"
                  : "text-on-surface-variant"
              }`}
            >
              <span className={active ? "text-primary" : "text-on-surface-variant/70"}>
                {tab.icon}
              </span>
              <span>{tab.label}</span>
              <span
                className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                  active
                    ? "bg-primary/15 text-primary"
                    : "bg-surface-high text-on-surface-variant"
                }`}
              >
                {tab.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {effectiveTab === "note" && (
        <NotesList notes={notes} onDelete={onDelete} />
      )}
      {effectiveTab === "todo" && (
        <TodosList todos={todos} onToggle={onToggle} onDelete={onDelete} />
      )}
      {effectiveTab === "place" && (
        <PlacesList places={places} onDelete={onDelete} />
      )}
    </div>
  );
}

function NotesList({
  notes,
  onDelete,
}: {
  notes: DocumentData[];
  onDelete?: (id: string) => void;
}) {
  return (
    <ul className="space-y-2">
      {notes.map((note) => (
        <li
          key={note.id}
          className="group relative flex items-start gap-3 rounded-xl bg-surface-low pl-3 pr-2 py-2.5 border-l-2 border-primary/40 transition-colors hover:bg-surface-container"
        >
          <span className="mt-0.5 shrink-0 flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary">
            <NoteIcon />
          </span>
          <p className="min-w-0 flex-1 text-sm text-on-surface whitespace-pre-wrap break-words leading-relaxed">
            {note.content}
          </p>
          {onDelete && <DeleteButton onClick={() => onDelete(note.id)} />}
        </li>
      ))}
    </ul>
  );
}

function TodosList({
  todos,
  onToggle,
  onDelete,
}: {
  todos: DocumentData[];
  onToggle?: (id: string, isCompleted: boolean) => void | Promise<void>;
  onDelete?: (id: string) => void;
}) {
  // Optimistic overrides keyed by action id. Cleared once the snapshot
  // reconciles (i.e. the server-side state matches what we optimistically set)
  // or explicitly reverted on error.
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setOptimistic((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const t of todos) {
        if (t.id in next && Boolean(t.is_completed) === next[t.id]) {
          delete next[t.id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [todos]);

  async function handleToggle(todo: DocumentData) {
    if (!onToggle) return;
    const current = optimistic[todo.id] ?? Boolean(todo.is_completed);
    const target = !current;
    setOptimistic((prev) => ({ ...prev, [todo.id]: target }));
    try {
      await onToggle(todo.id, target);
    } catch {
      setOptimistic((prev) => {
        const next = { ...prev };
        delete next[todo.id];
        return next;
      });
    }
  }

  return (
    <ul className="space-y-2">
      {todos.map((todo) => {
        const completed = optimistic[todo.id] ?? Boolean(todo.is_completed);
        return (
          <li
            key={todo.id}
            className="group relative flex items-center gap-3 rounded-xl bg-surface-low pl-3 pr-2 py-2.5 border-l-2 border-tertiary/40 transition-colors hover:bg-surface-container"
          >
            <button
              onClick={() => handleToggle(todo)}
              aria-pressed={completed}
              aria-label={completed ? "Mark as not done" : "Mark as done"}
              className="shrink-0 flex items-center justify-center h-6 w-6 rounded-full border-2 transition-all active:scale-90"
              style={{
                borderColor: completed
                  ? "var(--color-primary)"
                  : "var(--color-outline-variant)",
                backgroundColor: completed
                  ? "var(--color-primary)"
                  : "transparent",
              }}
            >
              <svg
                className={`h-3.5 w-3.5 text-on-primary transition-opacity duration-150 ${
                  completed ? "opacity-100" : "opacity-0"
                }`}
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={3}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="m4.5 12.75 6 6 9-13.5"
                />
              </svg>
            </button>
            <p
              className={`min-w-0 flex-1 text-sm text-on-surface whitespace-pre-wrap break-words leading-relaxed transition-all duration-200 ${
                completed ? "line-through opacity-50" : ""
              }`}
            >
              {todo.content}
            </p>
            {onDelete && <DeleteButton onClick={() => onDelete(todo.id)} />}
          </li>
        );
      })}
    </ul>
  );
}

function PlacesList({
  places,
  onDelete,
}: {
  places: DocumentData[];
  onDelete?: (id: string) => void;
}) {
  return (
    <ul className="space-y-2">
      {places.map((place) => {
        const placeData = place.place_data;
        const name: string | undefined = placeData?.name;
        const description: string | undefined =
          place.content && place.content !== name ? place.content : undefined;
        const category: string | undefined = placeData?.category;
        const mapsUrl = placeData?.place_id
          ? `https://www.google.com/maps/place/?q=place_id:${placeData.place_id}`
          : placeData?.lat_lng
            ? `https://www.google.com/maps/@${placeData.lat_lng.lat},${placeData.lat_lng.lng},17z`
            : null;

        return (
          <li
            key={place.id}
            className="group relative flex items-start gap-3 rounded-xl bg-gradient-to-br from-secondary/5 to-surface-low pl-3 pr-2 py-2.5 border-l-2 border-secondary/50 transition-colors hover:from-secondary/10"
          >
            <span className="mt-0.5 shrink-0 flex h-7 w-7 items-center justify-center rounded-full bg-secondary/15 text-secondary">
              <PinIcon />
            </span>
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex items-center gap-1.5 flex-wrap">
                {mapsUrl ? (
                  <a
                    href={mapsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-semibold text-on-surface hover:text-primary hover:underline truncate"
                  >
                    {name || place.content}
                  </a>
                ) : (
                  <span className="text-sm font-semibold text-on-surface truncate">
                    {name || place.content}
                  </span>
                )}
                {category && (
                  <span className="inline-flex items-center rounded-full bg-secondary/10 px-1.5 py-0.5 text-[10px] font-medium text-secondary">
                    {category}
                  </span>
                )}
              </div>
              {description && (
                <p className="text-xs text-on-surface-variant whitespace-pre-wrap break-words leading-relaxed">
                  {description}
                </p>
              )}
              {mapsUrl && (
                <a
                  href={mapsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-primary/80 hover:text-primary mt-0.5"
                >
                  <ExternalIcon />
                  Open in Maps
                </a>
              )}
            </div>
            {onDelete && <DeleteButton onClick={() => onDelete(place.id)} />}
          </li>
        );
      })}
    </ul>
  );
}

function DeleteButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="Delete"
      className="shrink-0 h-7 w-7 rounded-full flex items-center justify-center text-on-surface-variant/40 opacity-0 group-hover:opacity-100 hover:text-error hover:bg-error/10 focus:opacity-100 transition-all"
    >
      <svg
        className="h-3.5 w-3.5"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={2}
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M6 18 18 6M6 6l12 12"
        />
      </svg>
    </button>
  );
}

function NoteIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M16.862 4.487 18.549 2.8a2.121 2.121 0 1 1 3 3L19.862 7.487m-3-3L6.34 15.01a4.5 4.5 0 0 0-1.13 1.897l-.912 3.04 3.04-.912a4.5 4.5 0 0 0 1.897-1.13l10.523-10.523m-3-3 3 3"
      />
    </svg>
  );
}

function TodoIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
      />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z"
      />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg
      className="h-3 w-3"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
      />
    </svg>
  );
}
