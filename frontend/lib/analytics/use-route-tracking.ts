"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { trackScreenView } from "./events";

const TRIP_RE = /^\/trips\/([^/]+)(?:\/([^/]+))?/;

function getScreenContext(path: string): { screen_name: string; trip_id?: string; subroute?: string } {
  if (path === "/") return { screen_name: "trips_list" };
  if (path === "/sign-in") return { screen_name: "sign_in" };
  if (path === "/profile") return { screen_name: "profile" };
  if (path === "/trips/new") return { screen_name: "new_trip" };
  
  if (path.startsWith("/invite/")) return { screen_name: "invite_claim" };

  const match = TRIP_RE.exec(path);
  if (match) {
    const trip_id = match[1];
    const subroute = match[2];
    
    let screen_name = "trip_map";
    if (subroute === "import") screen_name = "trip_import";
    else if (subroute === "settings") screen_name = "trip_settings";
    else if (subroute) screen_name = `trip_${subroute}`;
    
    return { screen_name, trip_id, subroute };
  }
  
  return { screen_name: "unknown_screen" };
}

export function useRouteTracking(): void {
  const pathname = usePathname();
  const lastPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (!pathname || pathname === lastPathRef.current) return;
    lastPathRef.current = pathname;
    
    const { screen_name, trip_id, subroute } = getScreenContext(pathname);
    trackScreenView(screen_name, {
      page_path: pathname,
      ...(trip_id ? { trip_id } : {}),
      ...(subroute ? { subroute } : {}),
    });
  }, [pathname]);
}
