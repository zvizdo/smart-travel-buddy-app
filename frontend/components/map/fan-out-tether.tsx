"use client";

import { useEffect, useRef } from "react";
import { useMap } from "@vis.gl/react-google-maps";

interface FanOutTetherProps {
  /** Real geographic position */
  realLat: number;
  realLng: number;
  /** Displaced marker position */
  displayLat: number;
  displayLng: number;
  /** Accent color for the tether and anchor dot */
  color: string;
}

/**
 * Renders a dashed tether line from a displaced (fanned-out) node marker
 * back to its real lat/lng position, with a small anchor dot at the real position.
 * Everything is rendered as a single non-clickable Polyline to avoid intercepting
 * clicks meant for edges or edge labels underneath.
 */
export function FanOutTether({
  realLat,
  realLng,
  displayLat,
  displayLng,
  color,
}: FanOutTetherProps) {
  const map = useMap();
  const polylineRef = useRef<google.maps.Polyline | null>(null);

  useEffect(() => {
    if (!map) return;

    const line = new google.maps.Polyline({
      path: [
        { lat: realLat, lng: realLng },
        { lat: displayLat, lng: displayLng },
      ],
      strokeColor: color,
      strokeOpacity: 0, // main stroke invisible — dashes + dot via icons
      strokeWeight: 1.5,
      geodesic: false,
      clickable: false,
      zIndex: 50,
      icons: [
        // Dashed line pattern
        {
          icon: {
            path: "M 0,-1 0,1",
            strokeOpacity: 0.4,
            strokeWeight: 1.5,
            scale: 2,
          },
          offset: "0",
          repeat: "8px",
        },
        // Anchor dot at the real position (start of path)
        {
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 3.5,
            fillColor: color,
            fillOpacity: 1,
            strokeColor: "#fff",
            strokeWeight: 1.5,
            strokeOpacity: 1,
          },
          offset: "0%",
        },
      ],
    });
    line.setMap(map);
    polylineRef.current = line;

    return () => {
      line.setMap(null);
      polylineRef.current = null;
    };
  }, [map, realLat, realLng, displayLat, displayLng, color]);

  return null;
}
