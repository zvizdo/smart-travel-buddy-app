"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/components/auth/auth-provider";
import { api } from "@/lib/api";

export default function InviteClaimPage() {
  const params = useParams<{ tripId: string; token: string }>();
  const router = useRouter();
  const { user, loading: authLoading, signInWithGoogle } = useAuth();

  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading || !user) return;

    setClaiming(true);
    api
      .post<{ trip_id: string; role: string }>(
        `/trips/${params.tripId}/invites/${params.token}/claim`,
      )
      .then((result) => {
        router.push(`/trips/${result.trip_id}`);
      })
      .catch((err) => {
        setError(
          err instanceof Error ? err.message : "Failed to claim invite",
        );
        setClaiming(false);
      });
  }, [authLoading, user, params.tripId, params.token, router]);

  if (authLoading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-surface">
        <div className="h-8 w-8 animate-spin rounded-full border-3 border-surface-high border-t-primary" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex flex-1 items-center justify-center bg-surface px-6">
        <div className="text-center space-y-5">
          <div className="w-16 h-16 rounded-2xl gradient-primary flex items-center justify-center mx-auto shadow-ambient">
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
                d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z"
              />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-on-surface">Join a Trip</h1>
          <p className="text-sm text-on-surface-variant">
            Sign in to accept this invite
          </p>
          <button
            onClick={signInWithGoogle}
            className="gradient-primary rounded-2xl px-6 py-3.5 text-sm font-semibold text-on-primary shadow-ambient transition-all active:scale-[0.98]"
          >
            Sign in with Google
          </button>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center bg-surface px-6">
        <div className="text-center space-y-4">
          <div className="rounded-2xl bg-error/10 px-5 py-4">
            <p className="text-sm text-error font-medium">{error}</p>
          </div>
          <button
            onClick={() => router.push("/")}
            className="text-sm text-primary font-semibold"
          >
            Go to trips
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center bg-surface">
      <div className="flex items-center gap-3">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-surface-high border-t-primary" />
        <p className="text-sm text-on-surface-variant font-medium">
          {claiming ? "Joining trip..." : "Processing invite..."}
        </p>
      </div>
    </div>
  );
}
