export type ToastVariant = "default" | "error" | "success";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  message: string;
  variant?: ToastVariant;
  /** Milliseconds before auto-dismiss. Default 5000. Pass 0 to persist. */
  duration?: number;
  action?: ToastAction;
  /** Caller-supplied key for dedup — a second toast with the same id replaces the first. */
  id?: string;
}

export interface ToastEntry {
  id: string;
  message: string;
  variant: ToastVariant;
  duration: number;
  action: ToastAction | null;
}

type Listener = (toasts: ToastEntry[]) => void;

const MAX_VISIBLE = 3;

function createToastStore() {
  let toasts: ToastEntry[] = [];
  const listeners = new Set<Listener>();
  let counter = 0;

  function emit() {
    for (const listener of listeners) listener(toasts);
  }

  function show(options: ToastOptions | string): string {
    const opts: ToastOptions =
      typeof options === "string" ? { message: options } : options;
    const id = opts.id ?? `toast-${++counter}`;
    const entry: ToastEntry = {
      id,
      message: opts.message,
      variant: opts.variant ?? "default",
      duration: opts.duration ?? 5000,
      action: opts.action ?? null,
    };

    const existingIdx = toasts.findIndex((t) => t.id === id);
    if (existingIdx >= 0) {
      const next = toasts.slice();
      next[existingIdx] = entry;
      toasts = next;
    } else {
      toasts = [...toasts, entry];
      if (toasts.length > MAX_VISIBLE) {
        toasts = toasts.slice(toasts.length - MAX_VISIBLE);
      }
    }
    emit();
    return id;
  }

  function dismiss(id: string) {
    const next = toasts.filter((t) => t.id !== id);
    if (next.length === toasts.length) return;
    toasts = next;
    emit();
  }

  function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    listener(toasts);
    return () => {
      listeners.delete(listener);
    };
  }

  function getSnapshot(): ToastEntry[] {
    return toasts;
  }

  function reset() {
    toasts = [];
    counter = 0;
    emit();
  }

  return { show, dismiss, subscribe, getSnapshot, reset };
}

export const toastStore = createToastStore();

export function toast(options: ToastOptions | string): string {
  return toastStore.show(options);
}

export function dismissToast(id: string): void {
  toastStore.dismiss(id);
}
