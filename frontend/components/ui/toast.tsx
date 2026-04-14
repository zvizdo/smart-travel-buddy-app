"use client";

import { useEffect, useState } from "react";
import {
  toastStore,
  dismissToast,
  type ToastEntry,
} from "@/lib/toast-store";

export { toast, dismissToast } from "@/lib/toast-store";
export type { ToastOptions, ToastVariant } from "@/lib/toast-store";

const VARIANT_CLASSES: Record<ToastEntry["variant"], string> = {
  default: "bg-inverse-surface text-inverse-on-surface",
  error: "bg-error-container text-on-error-container",
  success: "bg-inverse-surface text-inverse-on-surface",
};

function ToastItem({ entry }: { entry: ToastEntry }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const showFrame = requestAnimationFrame(() => setVisible(true));
    if (entry.duration <= 0) return () => cancelAnimationFrame(showFrame);
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(() => dismissToast(entry.id), 300);
    }, entry.duration);
    return () => {
      cancelAnimationFrame(showFrame);
      clearTimeout(timer);
    };
  }, [entry.id, entry.duration]);

  function handleActionClick() {
    entry.action?.onClick();
    setVisible(false);
    setTimeout(() => dismissToast(entry.id), 300);
  }

  return (
    <div
      role="status"
      className={`pointer-events-auto flex items-center gap-3 rounded-2xl px-4 py-3 shadow-float transition-all duration-300 ${
        VARIANT_CLASSES[entry.variant]
      } ${
        visible
          ? "opacity-100 translate-y-0"
          : "opacity-0 -translate-y-2"
      }`}
    >
      <p className="text-sm font-medium flex-1 text-center">{entry.message}</p>
      {entry.action && (
        <button
          type="button"
          onClick={handleActionClick}
          className="shrink-0 text-sm font-semibold underline underline-offset-2"
        >
          {entry.action.label}
        </button>
      )}
    </div>
  );
}

export function ToastProvider() {
  const [toasts, setToasts] = useState<ToastEntry[]>(() =>
    toastStore.getSnapshot(),
  );

  useEffect(() => toastStore.subscribe(setToasts), []);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed top-16 left-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((entry) => (
        <ToastItem key={entry.id} entry={entry} />
      ))}
    </div>
  );
}

/**
 * Backward-compat wrapper: legacy callers that render `<Toast message={...} />`
 * forward into the imperative store. Callers should migrate to `toast(...)`.
 */
interface LegacyToastProps {
  message: string | null;
  duration?: number;
  onDismiss: () => void;
}

export function Toast({ message, duration = 5000, onDismiss }: LegacyToastProps) {
  useEffect(() => {
    if (!message) return;
    const id = toastStore.show({ message, duration });
    const cleanup = setTimeout(onDismiss, duration + 50);
    return () => {
      clearTimeout(cleanup);
      dismissToast(id);
    };
  }, [message, duration, onDismiss]);
  return null;
}
