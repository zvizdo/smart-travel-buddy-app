"use client";

import { useEffect, useRef, useState } from "react";

interface CreateDraftOverlayProps {
  onSubmit: (name: string) => void;
  onCancel: () => void;
  defaultName?: string;
}

export function CreateDraftOverlay({
  onSubmit,
  onCancel,
  defaultName = "",
}: CreateDraftOverlayProps) {
  const [name, setName] = useState(defaultName);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the input on mount so the user can start typing immediately
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  }

  function handleBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onCancel();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") onCancel();
  }

  return (
    // Backdrop — dims the map behind the card
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Create draft plan"
      className="fixed inset-0 z-50 flex items-center justify-center bg-inverse-surface/40 px-5"
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
    >
      {/* Card */}
      <div className="w-full max-w-sm rounded-2xl bg-surface-lowest shadow-float animate-fade-in">
        {/* Header */}
        <div className="px-5 pt-5 pb-3">
          <h2 className="text-base font-bold text-on-surface leading-tight">
            New draft plan
          </h2>
          <p className="mt-0.5 text-xs text-on-surface-variant">
            Give this version a short name so you can tell plans apart.
          </p>
        </div>

        {/* Form body */}
        <form onSubmit={handleSubmit}>
          <div className="px-5 pb-4">
            <label
              htmlFor="draft-plan-name"
              className="mb-1.5 block text-xs font-semibold text-on-surface-variant"
            >
              Plan name
            </label>
            <input
              ref={inputRef}
              id="draft-plan-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Beach route, Budget version…"
              maxLength={64}
              autoComplete="off"
              className="w-full bg-surface-high px-3 py-2 text-sm text-on-surface placeholder:text-outline rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          {/* Actions */}
          <div className="flex gap-3 px-5 pb-5">
            <button
              type="submit"
              disabled={!name.trim()}
              className="flex-1 min-h-[44px] rounded-xl gradient-primary text-sm font-semibold text-on-primary shadow-soft transition-all active:scale-[0.98] disabled:opacity-40"
            >
              Create
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 min-h-[44px] rounded-xl bg-surface-high text-sm font-semibold text-on-surface transition-all active:scale-[0.98]"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
