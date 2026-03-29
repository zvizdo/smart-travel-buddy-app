"use client";

import { useEffect, useState } from "react";

interface ToastProps {
  message: string | null;
  duration?: number;
  onDismiss: () => void;
}

export function Toast({ message, duration = 5000, onDismiss }: ToastProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!message) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(onDismiss, 300);
    }, duration);
    return () => clearTimeout(timer);
  }, [message, duration, onDismiss]);

  if (!message) return null;

  return (
    <div
      className={`absolute top-16 left-4 right-4 z-50 rounded-2xl bg-inverse-surface px-4 py-3 shadow-float transition-all duration-300 ${
        visible
          ? "opacity-100 translate-y-0"
          : "opacity-0 -translate-y-2 pointer-events-none"
      }`}
    >
      <p className="text-sm font-medium text-inverse-on-surface text-center">
        {message}
      </p>
    </div>
  );
}
