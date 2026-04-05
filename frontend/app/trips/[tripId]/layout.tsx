"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/components/auth/auth-provider";
import { useTrip, useTripPlans } from "@/lib/firestore-hooks";

export interface PlanData {
  id: string;
  name: string;
  status: string;
  parent_plan_id: string | null;
  created_by?: string;
  created_at: string;
}

interface TripSettings {
  datetime_format?: "12h" | "24h";
  date_format?: "us" | "eu" | "iso" | "short";
  distance_unit?: "km" | "mi";
}

interface TripData {
  id: string;
  name: string;
  active_plan_id: string | null;
  participants: Record<string, { role: string; display_name?: string; location_tracking_enabled?: boolean }>;
  settings?: TripSettings;
  [key: string]: unknown;
}

interface MapCamera {
  center: { lat: number; lng: number };
  zoom: number;
}

interface TripContextValue {
  tripId: string;
  trip: TripData | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
  mapFitted: boolean;
  markMapFitted: () => void;
  mapCamera: MapCamera | null;
  setMapCamera: (camera: MapCamera) => void;
  viewedPlanId: string | null;
  setViewedPlanId: (planId: string | null) => void;
  plans: PlanData[];
  plansLoading: boolean;
  setPlans: React.Dispatch<React.SetStateAction<PlanData[]>>;
}

const TripContext = createContext<TripContextValue | null>(null);

export function useTripContext(): TripContextValue {
  const ctx = useContext(TripContext);
  if (!ctx) {
    throw new Error("useTripContext must be used within TripLayout");
  }
  return ctx;
}

export default function TripLayout({ children }: { children: ReactNode }) {
  const params = useParams<{ tripId: string }>();
  const tripId = params.tripId;
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  // Real-time Firestore listener for the trip document.
  // This ensures active_plan_id changes (from plan promotion) propagate immediately.
  const { data: liveTrip, loading: liveTripLoading } = useTrip(
    user ? tripId : null,
  );

  // Also fetch via API for initial auth-verified load (Firestore rules may
  // differ from the backend's participant check).
  const [apiTrip, setApiTrip] = useState<TripData | null>(null);
  const [apiLoading, setApiLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const mapFittedRef = useRef(false);
  const mapCameraRef = useRef<MapCamera | null>(null);

  // Restore camera state from sessionStorage on mount (survives navigation to /profile)
  const restoredRef = useRef(false);
  if (!restoredRef.current) {
    restoredRef.current = true;
    try {
      mapFittedRef.current = sessionStorage.getItem(`trip-map-fitted:${tripId}`) === "1";
      const raw = sessionStorage.getItem(`trip-map-camera:${tripId}`);
      if (raw) mapCameraRef.current = JSON.parse(raw) as MapCamera;
    } catch {}
  }

  const markMapFitted = useCallback(() => {
    mapFittedRef.current = true;
    try { sessionStorage.setItem(`trip-map-fitted:${tripId}`, "1"); } catch {}
  }, [tripId]);
  const setMapCamera = useCallback((camera: MapCamera) => {
    mapCameraRef.current = camera;
    try { sessionStorage.setItem(`trip-map-camera:${tripId}`, JSON.stringify(camera)); } catch {}
  }, [tripId]);
  const [viewedPlanId, setViewedPlanId] = useState<string | null>(null);

  // Real-time Firestore listener for plans. This keeps the plan list in sync
  // when drafts are created/promoted/deleted anywhere (settings page, MCP,
  // another tab) so we never need a manual refresh.
  const { data: livePlans, loading: livePlansLoading } = useTripPlans(
    user ? tripId : null,
  );
  // Local override layer: lets pages do optimistic updates (e.g. immediately
  // after creating a draft). Reset to null whenever the live snapshot changes
  // so we stop shadowing once Firestore catches up.
  const [plansOverride, setPlansOverride] = useState<PlanData[] | null>(null);
  useEffect(() => {
    setPlansOverride(null);
  }, [livePlans]);
  const plans: PlanData[] = useMemo(
    () => plansOverride ?? (livePlans as unknown as PlanData[]),
    [plansOverride, livePlans],
  );
  const plansLoading = plansOverride === null && livePlansLoading;
  const setPlans: React.Dispatch<React.SetStateAction<PlanData[]>> =
    useCallback(
      (value) => {
        setPlansOverride((prev) => {
          const base = prev ?? (livePlans as unknown as PlanData[]);
          return typeof value === "function"
            ? (value as (prev: PlanData[]) => PlanData[])(base)
            : value;
        });
      },
      [livePlans],
    );

  function fetchTrip() {
    setApiLoading(true);
    api
      .get<TripData>(`/trips/${tripId}`)
      .then(setApiTrip)
      .catch((err) => setError(err instanceof Error ? err : new Error(String(err))))
      .finally(() => setApiLoading(false));
  }

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.push("/sign-in");
      return;
    }
    fetchTrip();
  }, [tripId, authLoading, user, router]);

  // Merge: prefer real-time Firestore data once available, fall back to API data.
  // The real-time listener keeps active_plan_id and participants fresh.
  const rawTrip: TripData | null = liveTrip
    ? (liveTrip as TripData)
    : apiTrip;
  // Show data as soon as Firestore cache returns — don't block on API round-trip.
  const loading = !rawTrip && (apiLoading || liveTripLoading);

  // Enrich participants with display names from users collection.
  // Firestore participant records may lack display_name for users who joined
  // before the field was added.
  const [userDataMap, setUserDataMap] = useState<Record<string, { display_name: string; location_tracking_enabled: boolean }>>({});
  const fetchedUidsRef = useRef<string>("");

  useEffect(() => {
    if (!rawTrip?.participants) return;
    const uids = Object.keys(rawTrip.participants);
    // Avoid re-fetching for the same set of participants.
    const key = [...uids].sort().join(",");
    if (key === fetchedUidsRef.current) return;
    fetchedUidsRef.current = key;

    api
      .post<{ users: Record<string, { display_name: string; location_tracking_enabled: boolean }> }>(
        "/users/batch",
        { user_ids: uids },
      )
      .then((res) => setUserDataMap(res.users))
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawTrip?.participants]);

  const trip = useMemo(() => {
    if (!rawTrip) return null;
    if (Object.keys(userDataMap).length === 0) return rawTrip;
    const enrichedParticipants: typeof rawTrip.participants = {};
    for (const [uid, p] of Object.entries(rawTrip.participants)) {
      const userData = userDataMap[uid];
      enrichedParticipants[uid] = {
        ...p,
        display_name: p.display_name || userData?.display_name || undefined,
        location_tracking_enabled: userData?.location_tracking_enabled ?? undefined,
      };
    }
    return { ...rawTrip, participants: enrichedParticipants };
  }, [rawTrip, userDataMap]);

  if (authLoading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-surface">
        <div className="h-8 w-8 animate-spin rounded-full border-3 border-surface-high border-t-primary" />
      </div>
    );
  }

  if (!user) {
    return null;
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-surface">
        <div className="h-8 w-8 animate-spin rounded-full border-3 border-surface-high border-t-primary" />
      </div>
    );
  }

  if (error || !trip) {
    return (
      <div className="flex flex-1 items-center justify-center bg-surface">
        <p className="text-error font-medium">Trip not found</p>
      </div>
    );
  }

  return (
    <TripContext.Provider value={{ tripId, trip, loading, error, refetch: fetchTrip, mapFitted: mapFittedRef.current, markMapFitted, mapCamera: mapCameraRef.current, setMapCamera, viewedPlanId, setViewedPlanId, plans, plansLoading, setPlans }}>
      {children}
    </TripContext.Provider>
  );
}
