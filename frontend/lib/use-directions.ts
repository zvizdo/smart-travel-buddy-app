"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMapsLibrary } from "@vis.gl/react-google-maps";

export interface TravelData {
  travel_mode: string;
  travel_time_hours: number;
  distance_km: number | null;
  route_polyline: string | null;
}

interface LatLng {
  lat: number;
  lng: number;
}

// Types for google.maps.routes.Route.computeRoutes (not yet in @types/google.maps)
interface ComputeRoutesRequest {
  origin: { location: { latLng: LatLng } };
  destination: { location: { latLng: LatLng } };
  travelMode: string;
}

interface ComputeRoutesResponse {
  routes: {
    distanceMeters: number;
    duration: string; // e.g. "3600s"
    polyline?: { encodedPolyline: string };
    legs: {
      distanceMeters: number;
      duration: string;
    }[];
  }[];
}

interface RoutesRouteClass {
  computeRoutes(
    request: ComputeRoutesRequest,
  ): Promise<ComputeRoutesResponse>;
}

/**
 * Infer our travel mode from distance (matches shared/dag/assembler.py logic).
 */
function inferTravelMode(distanceKm: number): string {
  if (distanceKm > 800) return "flight";
  if (distanceKm < 3) return "walk";
  return "drive";
}

/** Parse duration string like "3600s" to hours */
function parseDurationToHours(duration: string): number {
  const seconds = parseFloat(duration.replace("s", ""));
  return isNaN(seconds) ? 0 : seconds / 3600;
}

/** Haversine fallback */
function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/**
 * Hook that computes travel_time_hours, distance_km, and travel_mode
 * between two points using google.maps.routes.Route.computeRoutes.
 */
export function useDirections(
  origin: LatLng | null,
  destination: LatLng | null,
) {
  const routesLib = useMapsLibrary("routes");
  const [travelData, setTravelData] = useState<TravelData | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef(0);

  const compute = useCallback(async () => {
    if (!origin || !destination || !routesLib) {
      setTravelData(null);
      return;
    }

    const requestId = ++abortRef.current;
    setLoading(true);

    try {
      // Access the new Routes API: google.maps.routes.Route.computeRoutes
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const RouteClass: RoutesRouteClass | undefined = (routesLib as any).Route;

      if (!RouteClass?.computeRoutes) {
        throw new Error("Routes API not available");
      }

      const response = await RouteClass.computeRoutes({
        origin: { location: { latLng: origin } },
        destination: { location: { latLng: destination } },
        travelMode: "DRIVE",
      });

      if (requestId !== abortRef.current) return;

      const route = response.routes[0];
      if (!route) {
        setTravelData(null);
        return;
      }

      const distanceKm = route.distanceMeters / 1000;
      const travelTimeHours = parseDurationToHours(route.duration);
      const mode = inferTravelMode(distanceKm);

      // For flights, estimate time differently (rough ~800km/h)
      const finalTravelTime =
        mode === "flight" ? distanceKm / 800 : travelTimeHours;

      setTravelData({
        travel_mode: mode,
        travel_time_hours: Math.round(finalTravelTime * 100) / 100,
        distance_km: Math.round(distanceKm * 10) / 10,
        route_polyline:
          mode !== "flight"
            ? (route.polyline?.encodedPolyline ?? null)
            : null,
      });
    } catch {
      if (requestId !== abortRef.current) return;
      // Fallback: straight-line distance via haversine
      const distanceKm = haversineKm(origin, destination);
      const mode = inferTravelMode(distanceKm);
      const travelTimeHours =
        mode === "flight" ? distanceKm / 800 : distanceKm / 60;

      setTravelData({
        travel_mode: mode,
        travel_time_hours: Math.round(travelTimeHours * 100) / 100,
        distance_km: Math.round(distanceKm * 10) / 10,
        route_polyline: null,
      });
    } finally {
      if (requestId === abortRef.current) setLoading(false);
    }
  }, [origin, destination, routesLib]);

  // Auto-compute when origin/destination change
  useEffect(() => {
    compute();
  }, [compute]);

  return { travelData, loading };
}
