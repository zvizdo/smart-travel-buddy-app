"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth/auth-provider";
import { api } from "@/lib/api";

export default function NewTripPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) {
    router.replace("/sign-in");
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    setSubmitting(true);
    setError(null);
    try {
      const trip = await api.post<{ id: string }>("/trips", { name: trimmed });
      router.push(`/trips/${trip.id}/import`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create trip");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col flex-1 bg-surface">
      {/* Header */}
      <header className="flex items-center gap-3 px-5 pt-14 pb-4 bg-surface-lowest">
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
        <h1 className="text-lg font-bold text-on-surface">New Trip</h1>
      </header>

      {/* Content */}
      <main className="flex-1 px-6 py-10 max-w-md mx-auto w-full">
        <div className="text-center mb-10">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
            <svg
              className="h-8 w-8 text-primary"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5a17.92 17.92 0 0 1-8.716-2.247m0 0A8.966 8.966 0 0 1 3 12c0-1.97.633-3.792 1.708-5.272"
              />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-on-surface mb-1">
            Name your adventure
          </h2>
          <p className="text-sm text-on-surface-variant">
            Give your trip a memorable name
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <input
              id="trip-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Europe Summer 2026"
              maxLength={200}
              className="w-full rounded-2xl bg-surface-high px-5 py-4 text-base text-on-surface placeholder:text-outline focus:outline-none focus:ring-2 focus:ring-primary/40 transition-shadow"
              autoFocus
            />
          </div>

          {error && (
            <div className="rounded-2xl bg-error-container/15 px-4 py-3 text-sm text-error">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || !name.trim()}
            className="gradient-primary w-full rounded-2xl py-4 text-base font-semibold text-on-primary shadow-ambient transition-all active:scale-[0.98] disabled:opacity-40 disabled:active:scale-100"
          >
            {submitting ? (
              <span className="flex items-center justify-center gap-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-on-primary/30 border-t-on-primary" />
                Creating...
              </span>
            ) : (
              "Create & Import"
            )}
          </button>
        </form>
      </main>
    </div>
  );
}
