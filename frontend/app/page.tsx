"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth/auth-provider";
import { ProfileAvatar } from "@/components/ui/profile-avatar";
import { api } from "@/lib/api";
import { trackTripOpened, trackTripsListLoaded } from "@/lib/analytics";

interface TripSummary {
  id: string;
  name: string;
  role: string;
  active_plan_id: string | null;
}

const ROLE_COLORS: Record<string, string> = {
  admin: "bg-primary/10 text-primary",
  planner: "bg-secondary/10 text-secondary",
  viewer: "bg-on-surface-variant/10 text-on-surface-variant",
};

export default function HomePage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [trips, setTrips] = useState<TripSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.replace("/sign-in");
      return;
    }

    api
      .get<{ trips: TripSummary[] }>("/trips")
      .then((data) => {
        setTrips(data.trips);
        trackTripsListLoaded(data.trips.length);
      })
      .catch(() => setTrips([]))
      .finally(() => setLoading(false));
  }, [user, authLoading, router]);

  if (authLoading || (!user && !authLoading)) {
    return (
      <div className="flex flex-1 items-center justify-center bg-surface">
        <div className="h-8 w-8 animate-spin rounded-full border-3 border-surface-high border-t-primary" />
      </div>
    );
  }

  const firstName = user?.displayName?.split(" ")[0] || "Explorer";

  return (
    <div className="flex flex-col flex-1 bg-surface">
      {/* Header */}
      <header className="bg-surface-lowest px-5 pt-14 pb-8">
        <div className="max-w-lg mx-auto">
          <div className="flex items-center justify-between mb-8">
            <p className="text-sm font-medium text-on-surface-variant tracking-wide uppercase">
              Travel Buddy
            </p>
            <ProfileAvatar name={user?.displayName} />
          </div>

          <h1 className="text-3xl font-bold text-on-surface mb-1">
            Welcome back,
          </h1>
          <h2 className="text-3xl font-bold text-primary">{firstName}.</h2>
          <p className="text-on-surface-variant mt-3">
            Ready for your next adventure?
          </p>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 px-5 -mt-2">
        <div className="max-w-lg mx-auto">
          {/* New Trip CTA */}
          <Link
            href="/trips/new"
            className="gradient-primary flex items-center justify-center gap-2 w-full rounded-2xl px-6 py-4 text-on-primary font-semibold text-base shadow-ambient transition-transform active:scale-[0.98] mb-8"
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
                d="M12 4.5v15m7.5-7.5h-15"
              />
            </svg>
            New Trip
          </Link>

          {/* Trip List */}
          {loading ? (
            <div className="flex justify-center py-16">
              <div className="h-8 w-8 animate-spin rounded-full border-3 border-surface-high border-t-primary" />
            </div>
          ) : trips.length === 0 ? (
            <div className="text-center py-16 px-6">
              <div className="w-16 h-16 rounded-full bg-surface-low flex items-center justify-center mx-auto mb-4">
                <svg
                  className="h-8 w-8 text-on-surface-variant"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 6.75V15m6-6v8.25m.503 3.498 4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 0 0-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0Z"
                  />
                </svg>
              </div>
              <p className="text-on-surface-variant font-medium mb-2">
                No trips yet — let's fix that
              </p>
              <p className="text-sm text-outline">
                Start by creating your first trip.
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-baseline justify-between mb-4">
                <h3 className="text-lg font-bold text-on-surface">
                  Your Trips
                </h3>
                <span className="text-sm text-on-surface-variant">
                  {trips.length} {trips.length === 1 ? "trip" : "trips"}
                </span>
              </div>

              <ul className="space-y-3 pb-8">
                {trips.map((trip) => (
                  <li key={trip.id}>
                    <Link
                      href={`/trips/${trip.id}`}
                      onClick={() => trackTripOpened(trip.id, trip.role)}
                      className="block rounded-2xl bg-surface-lowest p-5 shadow-soft transition-all active:scale-[0.98] hover:shadow-ambient"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <h4 className="font-semibold text-on-surface truncate">
                            {trip.name}
                          </h4>
                          <div className="flex items-center gap-2 mt-2">
                            <span
                              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${ROLE_COLORS[trip.role] || ROLE_COLORS.viewer}`}
                            >
                              {trip.role}
                            </span>
                            {trip.active_plan_id && (
                              <span className="inline-flex items-center gap-1 text-xs text-secondary font-medium">
                                <span className="h-1.5 w-1.5 rounded-full bg-secondary" />
                                Active plan
                              </span>
                            )}
                          </div>
                        </div>
                        <svg
                          className="h-5 w-5 text-outline-variant flex-shrink-0 mt-0.5"
                          fill="none"
                          viewBox="0 0 24 24"
                          strokeWidth={2}
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="m8.25 4.5 7.5 7.5-7.5 7.5"
                          />
                        </svg>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
