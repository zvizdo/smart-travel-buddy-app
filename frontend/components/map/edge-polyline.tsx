"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useMap, useMapsLibrary } from "@vis.gl/react-google-maps";

interface EdgePolylineProps {
  fromLat: number;
  fromLng: number;
  toLat: number;
  toLng: number;
  travelMode?: string;
  travelTimeHours?: number;
  distanceKm?: number | null;
  routePolyline?: string | null;
  selected?: boolean;
  pathColor?: string;
  dimmed?: boolean;
  timingWarning?: boolean;
  /** Pixel distance between the from/to nodes at current zoom. Used to hide label when too close. */
  pixelDistance?: number;
  onClick?: () => void;
}

const MODE_COLORS: Record<string, string> = {
  drive: "#006479",
  flight: "#5e35b1",
  transit: "#9a7c00",
  walk: "#006b1b",
};

const MODE_DASH: Record<string, number[]> = {
  flight: [10, 5],
  walk: [4, 5],
};

const MODE_ICON_SVG: Record<string, string> = {
  drive: `<path d="M19 17H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h11l4 4v4a2 2 0 0 1-2 2z" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="7" cy="17" r="2" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="17" cy="17" r="2" stroke="currentColor" stroke-width="2" fill="none"/>`,
  flight: `<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21 4 19 4s-2 1-3.5 2.5L11 8.2 4.8 6.4c-.7-.3-1.2 0-1.4.7L3 8l5.5 2.5L6.5 14l-2-.5-.8 2 3 1.5 1.5 3 2-.8-.5-2 3.5-2L19 22z" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
  transit: `<rect width="16" height="16" x="4" y="3" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M4 11h16M12 3v8" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><circle cx="8.5" cy="17" r="1.5" fill="currentColor"/><circle cx="15.5" cy="17" r="1.5" fill="currentColor"/>`,
  walk: `<circle cx="13" cy="4" r="1" fill="currentColor"/><path d="m7 21 1-4m6 4-1-4M9 8.5 7 21M5 9l4-1 1 4 4 2" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
};

/** Minimum pixel distance between nodes to show the edge info label */
const MIN_PX_FOR_LABEL = 120;

/** Ease-in-out-quad for smooth opacity transitions */
function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

function formatDuration(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function EdgePolyline({
  fromLat,
  fromLng,
  toLat,
  toLng,
  travelMode = "drive",
  travelTimeHours,
  distanceKm,
  routePolyline,
  selected,
  pathColor,
  dimmed,
  timingWarning,
  pixelDistance,
  onClick,
}: EdgePolylineProps) {
  const map = useMap();
  const geometryLib = useMapsLibrary("geometry");
  const markerLib = useMapsLibrary("marker");
  const polylineRef = useRef<google.maps.Polyline | null>(null);
  const hitPolylineRef = useRef<google.maps.Polyline | null>(null);
  const midMarkerRef =
    useRef<google.maps.marker.AdvancedMarkerElement | null>(null);

  // Stable ref for the onClick callback — avoids re-creating polylines when only
  // the handler identity changes (e.g. due to inline arrows in the parent).
  const onClickRef = useRef(onClick);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { onClickRef.current = onClick; });

  // Refs to mutable DOM nodes inside the midpoint badge so we can update them
  // in-place rather than destroying and recreating the marker.
  const badgeElRef = useRef<HTMLDivElement | null>(null);
  const iconWrapRef = useRef<HTMLSpanElement | null>(null);
  const durationSpanRef = useRef<HTMLSpanElement | null>(null);
  const distanceSpanRef = useRef<HTMLSpanElement | null>(null);
  const warnSpanRef = useRef<HTMLSpanElement | null>(null);

  // Animated opacity state for dimmed transitions
  const currentOpacityRef = useRef<number>(dimmed ? 0.25 : 0.85);
  const animFrameRef = useRef<number>(0);

  // Decode route polyline or fall back to straight line
  const path = useMemo(() => {
    if (
      routePolyline &&
      travelMode !== "flight" &&
      geometryLib
    ) {
      try {
        return google.maps.geometry.encoding.decodePath(routePolyline);
      } catch {
        // Fall through to straight line
      }
    }
    return [
      { lat: fromLat, lng: fromLng },
      { lat: toLat, lng: toLng },
    ];
  }, [routePolyline, travelMode, geometryLib, fromLat, fromLng, toLat, toLng]);

  // Compute midpoint for the info badge
  const midpoint = useMemo(() => {
    if (path.length > 2) {
      const mid = path[Math.floor(path.length / 2)];
      const lat = typeof mid.lat === "function" ? (mid.lat as () => number)() : mid.lat;
      const lng = typeof mid.lng === "function" ? (mid.lng as () => number)() : mid.lng;
      return { lat, lng };
    }
    return { lat: (fromLat + toLat) / 2, lng: (fromLng + toLng) / 2 };
  }, [path, fromLat, fromLng, toLat, toLng]);

  // Derived visual properties (excluding dimmed/selected — those are handled
  // by the options update effect and the opacity animation respectively).
  const rawColor = dimmed
    ? "#d4d4d8"
    : timingWarning
      ? "#d97706"
      : pathColor || MODE_COLORS[travelMode] || "#6b7280";
  const strokeWeight = selected ? 4 : 2.5;
  const dash = dimmed ? undefined : MODE_DASH[travelMode];

  // Should we show the label? Only when nodes are far enough apart on screen
  const showLabel =
    !dimmed &&
    (travelTimeHours || timingWarning) &&
    (pixelDistance === undefined || pixelDistance >= MIN_PX_FOR_LABEL);

  // ---------------------------------------------------------------------------
  // Effect A: CREATE polyline (and hit target) — only when map or path changes.
  // Visual options (color, weight, opacity, dash) are set to initial values here
  // but are kept in sync by Effect B without tearing down the polyline.
  // onClick is read through onClickRef so it never belongs in this dep array.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!map) return;

    const initialOpacity = currentOpacityRef.current;
    const initialDash = dimmed ? undefined : MODE_DASH[travelMode];
    const initialColor = dimmed
      ? "#d4d4d8"
      : timingWarning
        ? "#d97706"
        : pathColor || MODE_COLORS[travelMode] || "#6b7280";
    const initialWeight = selected ? 4 : 2.5;

    const arrowTip: google.maps.IconSequence = {
      icon: {
        path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
        scale: selected ? 4 : 3,
        strokeColor: initialColor,
        fillColor: initialColor,
        fillOpacity: dimmed ? 0.25 : 0.95,
        strokeOpacity: dimmed ? 0.25 : 0.95,
        strokeWeight: 1,
      },
      offset: "100%",
    };

    const midArrow: google.maps.IconSequence = {
      icon: {
        path: google.maps.SymbolPath.FORWARD_OPEN_ARROW,
        scale: 2.5,
        strokeColor: initialColor,
        strokeOpacity: dimmed ? 0.25 : 0.7,
        strokeWeight: 1.5,
      },
      offset: "50%",
    };

    const polyline = new google.maps.Polyline({
      path,
      strokeColor: initialColor,
      strokeOpacity: initialDash ? 0 : initialOpacity,
      strokeWeight: initialWeight,
      map,
      clickable: true,
      icons: [arrowTip, midArrow],
    });

    if (initialDash) {
      polyline.setOptions({
        strokeOpacity: 0,
        icons: [
          {
            icon: {
              path: "M 0,-1 0,1",
              strokeOpacity: initialOpacity,
              strokeColor: initialColor,
              scale: initialWeight,
            },
            offset: "0",
            repeat: `${initialDash[0] + initialDash[1]}px`,
          },
          arrowTip,
          midArrow,
        ],
      });
    }

    // Use the ref so swapping onClick in the parent never re-mounts the polyline
    polyline.addListener("click", () => onClickRef.current?.());
    polylineRef.current = polyline;

    // Invisible wide polyline for easier touch targeting
    const hitPoly = new google.maps.Polyline({
      path,
      strokeColor: "transparent",
      strokeOpacity: 0,
      strokeWeight: 20,
      map,
      clickable: true,
    });
    hitPoly.addListener("click", () => onClickRef.current?.());
    hitPolylineRef.current = hitPoly;

    return () => {
      polyline.setMap(null);
      polylineRef.current = null;
      hitPoly.setMap(null);
      hitPolylineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // onClick intentionally excluded — handled via onClickRef to avoid re-mounts
  }, [map, path]);

  // ---------------------------------------------------------------------------
  // Effect B: UPDATE polyline options in-place when visual props change.
  // Runs after creation and on every subsequent visual-prop change.
  // Does NOT tear down the polyline — only calls setOptions.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const polyline = polylineRef.current;
    if (!polyline) return;

    const currentOpacity = currentOpacityRef.current;

    const arrowTip: google.maps.IconSequence = {
      icon: {
        path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
        scale: selected ? 4 : 3,
        strokeColor: rawColor,
        fillColor: rawColor,
        fillOpacity: currentOpacity,
        strokeOpacity: currentOpacity,
        strokeWeight: 1,
      },
      offset: "100%",
    };

    const midArrow: google.maps.IconSequence = {
      icon: {
        path: google.maps.SymbolPath.FORWARD_OPEN_ARROW,
        scale: 2.5,
        strokeColor: rawColor,
        strokeOpacity: Math.min(currentOpacity, 0.7),
        strokeWeight: 1.5,
      },
      offset: "50%",
    };

    if (dash) {
      polyline.setOptions({
        strokeColor: rawColor,
        strokeOpacity: 0,
        strokeWeight,
        clickable: true,
        icons: [
          {
            icon: {
              path: "M 0,-1 0,1",
              strokeOpacity: currentOpacity,
              strokeColor: rawColor,
              scale: strokeWeight,
            },
            offset: "0",
            repeat: `${dash[0] + dash[1]}px`,
          },
          arrowTip,
          midArrow,
        ],
      });
    } else {
      polyline.setOptions({
        strokeColor: rawColor,
        strokeOpacity: currentOpacity,
        strokeWeight,
        clickable: true,
        icons: [arrowTip, midArrow],
      });
    }
  }, [rawColor, strokeWeight, dash, selected]);

  // ---------------------------------------------------------------------------
  // Opacity animation — animates dimmed transitions over 350ms.
  // Cancels any in-flight animation before starting a new one.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const targetOpacity = dimmed ? 0.25 : 0.85;
    const startOpacity = currentOpacityRef.current;

    if (startOpacity === targetOpacity) return;

    cancelAnimationFrame(animFrameRef.current);

    const duration = 350;
    const startTime = performance.now();

    function tick(now: number) {
      const elapsed = now - startTime;
      const raw = Math.min(elapsed / duration, 1);
      const t = easeInOutQuad(raw);
      const opacity = startOpacity + (targetOpacity - startOpacity) * t;
      currentOpacityRef.current = opacity;

      const polyline = polylineRef.current;
      if (polyline) {
        const currentDash = dimmed ? undefined : MODE_DASH[travelMode];
        if (currentDash) {
          const icons = polyline.get("icons") as google.maps.IconSequence[] | undefined;
          if (icons) {
            const updated = icons.map((seq) => {
              if (seq.repeat) {
                // dashed segment
                return {
                  ...seq,
                  icon: { ...seq.icon, strokeOpacity: opacity },
                };
              }
              if (seq.offset === "100%") {
                // arrow tip
                return {
                  ...seq,
                  icon: { ...seq.icon, fillOpacity: opacity, strokeOpacity: opacity },
                };
              }
              if (seq.offset === "50%") {
                // mid arrow
                return {
                  ...seq,
                  icon: { ...seq.icon, strokeOpacity: Math.min(opacity, 0.7) },
                };
              }
              return seq;
            });
            polyline.setOptions({ icons: updated as google.maps.IconSequence[] });
          }
        } else {
          polyline.setOptions({ strokeOpacity: opacity });
          const icons = polyline.get("icons") as google.maps.IconSequence[] | undefined;
          if (icons) {
            const updated = icons.map((seq) => {
              if (seq.offset === "100%") {
                return {
                  ...seq,
                  icon: { ...seq.icon, fillOpacity: opacity, strokeOpacity: opacity },
                };
              }
              if (seq.offset === "50%") {
                return {
                  ...seq,
                  icon: { ...seq.icon, strokeOpacity: Math.min(opacity, 0.7) },
                };
              }
              return seq;
            });
            polyline.setOptions({ icons: updated as google.maps.IconSequence[] });
          }
        }
      }

      // Also animate badge opacity if it exists
      if (badgeElRef.current) {
        badgeElRef.current.style.opacity = String(opacity);
      }

      if (raw < 1) {
        animFrameRef.current = requestAnimationFrame(tick);
      }
    }

    animFrameRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(animFrameRef.current);
    };
  }, [dimmed, travelMode]);

  // ---------------------------------------------------------------------------
  // Midpoint info badge — created ONCE when map is available; updated in-place.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!map || !markerLib) return;

    const el = document.createElement("div");
    el.style.cssText = [
      "display:inline-flex",
      "align-items:center",
      "gap:4px",
      "background:rgba(255,255,255,0.92)",
      "backdrop-filter:blur(8px)",
      "-webkit-backdrop-filter:blur(8px)",
      "border-radius:20px",
      "padding:3px 8px 3px 5px",
      "font-size:11px",
      "font-weight:600",
      "color:#283030",
      "letter-spacing:-0.01em",
      "line-height:1",
      "box-shadow:0 1px 6px rgba(0,0,0,0.16), inset 0 0 0 1.5px #00647940",
      "white-space:nowrap",
      "font-family:system-ui,sans-serif",
      "transition:opacity 0.35s ease",
      "cursor:pointer",
      "pointer-events:auto",
    ].join(";");

    badgeElRef.current = el;

    // Warning span
    const warn = document.createElement("span");
    warn.style.cssText = "color:#d97706;font-size:12px;font-weight:700;line-height:1";
    warnSpanRef.current = warn;
    el.appendChild(warn);

    // Mode icon wrapper
    const iconWrap = document.createElement("span");
    iconWrap.style.cssText = "display:flex;align-items:center";
    iconWrapRef.current = iconWrap;
    el.appendChild(iconWrap);

    // Duration span
    const durSpan = document.createElement("span");
    durationSpanRef.current = durSpan;
    el.appendChild(durSpan);

    // Separator + distance
    const sep = document.createElement("span");
    sep.style.cssText = "color:#9ca3af;margin:0 1px";
    sep.textContent = "\u00B7";

    const distSpan = document.createElement("span");
    distSpan.style.color = "#707978";
    distanceSpanRef.current = distSpan;
    el.appendChild(sep);
    el.appendChild(distSpan);

    // Stop map click propagation from the badge
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      onClickRef.current?.();
    });

    const marker = new google.maps.marker.AdvancedMarkerElement({
      map: null, // visibility controlled below
      position: midpoint,
      content: el,
      zIndex: 90,
    });

    marker.addEventListener("gmp-click", (e: Event) => {
      e.stopPropagation();
      onClickRef.current?.();
    });

    midMarkerRef.current = marker;

    return () => {
      marker.map = null;
      midMarkerRef.current = null;
      badgeElRef.current = null;
      iconWrapRef.current = null;
      durationSpanRef.current = null;
      distanceSpanRef.current = null;
      warnSpanRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // onClick intentionally excluded — handled via onClickRef
    // midpoint intentionally excluded — position updated in the options effect below
  }, [map, markerLib]);

  // ---------------------------------------------------------------------------
  // Badge content + visibility update — runs whenever label content props change.
  // Updates DOM children in-place; toggles marker.map for show/hide.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const marker = midMarkerRef.current;
    if (!marker) return;

    const badgeColor = timingWarning
      ? "#d97706"
      : MODE_COLORS[travelMode] || "#6b7280";
    const iconSvg = MODE_ICON_SVG[travelMode] ?? MODE_ICON_SVG["drive"];
    const durationStr = travelTimeHours ? formatDuration(travelTimeHours) : "";
    const distStr =
      distanceKm != null ? `${Math.round(distanceKm)} km` : "";

    // Update warning indicator
    if (warnSpanRef.current) {
      warnSpanRef.current.textContent = timingWarning ? "!" : "";
      warnSpanRef.current.style.display = timingWarning ? "" : "none";
    }

    // Update mode icon
    if (iconWrapRef.current) {
      iconWrapRef.current.style.color = badgeColor;
      iconWrapRef.current.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24">${iconSvg}</svg>`;
    }

    // Update duration text
    if (durationSpanRef.current) {
      durationSpanRef.current.textContent = durationStr;
      durationSpanRef.current.style.color = timingWarning ? "#d97706" : "#283030";
    }

    // Update distance text — hide when warning to save space
    if (distanceSpanRef.current) {
      const showDist = !!distStr && !timingWarning;
      distanceSpanRef.current.textContent = showDist ? distStr : "";
      distanceSpanRef.current.style.display = showDist ? "" : "none";
      // Also hide the separator when distance is hidden
      const sep = distanceSpanRef.current.previousSibling as HTMLElement | null;
      if (sep) sep.style.display = showDist ? "" : "none";
    }

    // Update box-shadow accent color
    if (badgeElRef.current) {
      badgeElRef.current.style.boxShadow = `0 1px 6px rgba(0,0,0,0.16), inset 0 0 0 1.5px ${badgeColor}40`;
    }

    // Update position
    marker.position = midpoint;

    // Toggle visibility with a fade-in animation when showing
    if (showLabel) {
      if (marker.map !== map) {
        if (badgeElRef.current) badgeElRef.current.style.opacity = "0";
        marker.map = map;
        // Fade in on next frame
        requestAnimationFrame(() => {
          if (badgeElRef.current) badgeElRef.current.style.opacity = "1";
        });
      }
    } else {
      marker.map = null;
    }
  }, [
    map,
    showLabel,
    timingWarning,
    travelMode,
    travelTimeHours,
    distanceKm,
    midpoint,
  ]);

  return null;
}
