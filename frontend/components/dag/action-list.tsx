"use client";

import { useState } from "react";
import { type DocumentData } from "firebase/firestore";

export type ActionTab = "note" | "todo" | "place";

interface ActionListProps {
  actions: DocumentData[];
  loading?: boolean;
  onToggle?: (actionId: string, isCompleted: boolean) => void;
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

  const defaultTab: ActionTab = notes.length > 0 ? "note" : todos.length > 0 ? "todo" : "place";
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

  const tabs: { key: ActionTab; label: string; count: number }[] = [
    { key: "note", label: "Notes", count: notes.length },
    { key: "todo", label: "Todos", count: todos.length },
    { key: "place", label: "Places", count: places.length },
  ];

  const visibleTabs = tabs.filter((t) => t.count > 0);
  if (visibleTabs.length === 0) return null;

  // Auto-select first visible tab if current tab has no items
  const effectiveTab =
    visibleTabs.find((t) => t.key === activeTab) ? activeTab : visibleTabs[0].key;

  return (
    <div className="space-y-2">
      {/* Tab bar */}
      <div className="flex border-b border-outline-variant">
        {visibleTabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => selectTab(tab.key)}
            className={`relative px-3 pb-2 pt-1 text-xs font-medium transition-colors ${
              effectiveTab === tab.key
                ? "text-primary"
                : "text-on-surface-variant"
            }`}
          >
            {tab.label}
            <span className="ml-1 text-[10px] opacity-60">{tab.count}</span>
            {effectiveTab === tab.key && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
            )}
          </button>
        ))}
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
    <ul className="space-y-1.5">
      {notes.map((note) => (
        <li
          key={note.id}
          className="flex items-start gap-2 text-sm rounded-lg bg-surface-low px-3 py-2 group"
        >
          <span className="mt-0.5 shrink-0 text-on-surface-variant">
            <NoteIcon />
          </span>
          <p className="min-w-0 flex-1 text-on-surface">{note.content}</p>
          {onDelete && (
            <DeleteButton onClick={() => onDelete(note.id)} />
          )}
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
  onToggle?: (id: string, isCompleted: boolean) => void;
  onDelete?: (id: string) => void;
}) {
  return (
    <ul className="space-y-1.5">
      {todos.map((todo) => (
        <li
          key={todo.id}
          className="flex items-center gap-2 text-sm rounded-lg bg-surface-low px-3 py-2 group"
        >
          <button
            onClick={() => onToggle?.(todo.id, !todo.is_completed)}
            className="shrink-0 flex items-center justify-center h-5 w-5 rounded border-2 transition-colors"
            style={{
              borderColor: todo.is_completed
                ? "var(--color-primary)"
                : "var(--color-outline-variant)",
              backgroundColor: todo.is_completed
                ? "var(--color-primary)"
                : "transparent",
            }}
          >
            {todo.is_completed && (
              <svg
                className="h-3 w-3 text-on-primary"
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
            )}
          </button>
          <p
            className={`min-w-0 flex-1 text-on-surface ${
              todo.is_completed ? "line-through opacity-50" : ""
            }`}
          >
            {todo.content}
          </p>
          {onDelete && (
            <DeleteButton onClick={() => onDelete(todo.id)} />
          )}
        </li>
      ))}
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
    <ul className="space-y-1.5">
      {places.map((place) => {
        const placeData = place.place_data;
        const mapsUrl = placeData?.place_id
          ? `https://www.google.com/maps/place/?q=place_id:${placeData.place_id}`
          : placeData?.lat_lng
            ? `https://www.google.com/maps/@${placeData.lat_lng.lat},${placeData.lat_lng.lng},17z`
            : null;

        return (
          <li
            key={place.id}
            className="flex items-center gap-2 text-sm rounded-lg bg-surface-low px-3 py-2 group"
          >
            <span className="shrink-0 text-on-surface-variant">
              <PinIcon />
            </span>
            <div className="min-w-0 flex-1">
              {mapsUrl ? (
                <a
                  href={mapsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary font-medium hover:underline"
                >
                  {placeData?.name || place.content}
                </a>
              ) : (
                <span className="text-on-surface font-medium">
                  {place.content}
                </span>
              )}
            </div>
            {onDelete && (
              <DeleteButton onClick={() => onDelete(place.id)} />
            )}
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
      className="shrink-0 h-6 w-6 rounded-full flex items-center justify-center text-on-surface-variant/50 active:text-error active:bg-error/10 transition-colors"
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
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
      />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
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
