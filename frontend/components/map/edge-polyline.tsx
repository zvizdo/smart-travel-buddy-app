"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useMap, useMapsLibrary } from "@vis.gl/react-google-maps";
import { formatDistance } from "@/lib/dates";

interface EdgePolylineProps {
  fromLat: number;
  fromLng: number;
  toLat: number;
  toLng: number;
  travelMode?: string;
  travelTimeHours?: number;
  distanceKm?: number | null;
  distanceUnit?: "km" | "mi";
  routePolyline?: string | null;
  selected?: boolean;
  pathColor?: string;
  dimmed?: boolean;
  timingWarning?: boolean;
  /** When true, edge shows shimmer animation indicating polyline is being recalculated */
  recalculating?: boolean;
  /** Pixel distance between the from/to nodes at current zoom. Used to hide label when too close. */
  pixelDistance?: number;
  /** Display name of the source node (for directional badge) */
  fromNodeName?: string;
  /** Display name of the destination node (for directional badge) */
  toNodeName?: string;
  onClick?: (clickLatLng?: { lat: number; lng: number }) => void;
}

const MODE_COLORS: Record<string, string> = {
  drive: "#006479",
  flight: "#5e35b1",
  transit: "#9a7c00",
  walk: "#006b1b",
};

/** Darker casing colors per mode (fill color darkened ~45%) */
const CASING_COLORS: Record<string, string> = {
  drive: "#003d49",
  flight: "#3a1f70",
  transit: "#5c4a00",
  walk: "#004010",
};

const MODE_DASH: Record<string, number[]> = {
  flight: [10, 5],
  walk: [4, 5],
};

/** Build a repeating directional arrow icon for the fill polyline */
function buildFillArrows(
  fillColor: string,
  opacity: number,
  selected: boolean,
  pixelDistance?: number,
): google.maps.IconSequence {
  const singleArrow = pixelDistance !== undefined && pixelDistance < 160;
  return {
    icon: {
      path: google.maps.SymbolPath.FORWARD_OPEN_ARROW,
      scale: selected ? 3.5 : 2.5,
      strokeColor: fillColor,
      strokeOpacity: opacity,
      strokeWeight: 1.5,
    },
    offset: "50%",
    repeat: singleArrow ? "0" : "160px",
  };
}

/** First 3 uppercase alpha chars of a name, for badge direction labels */
function abbreviate(name?: string): string {
  if (!name) return "???";
  return name.replace(/[^a-zA-Z]/g, "").slice(0, 3).toUpperCase()
    || name.slice(0, 3).toUpperCase();
}

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

/** Darken a hex color by a factor (0 = black, 1 = unchanged) */
function darkenHex(hex: string, factor = 0.55): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `#${Math.round(r * factor).toString(16).padStart(2, "0")}${Math.round(g * factor).toString(16).padStart(2, "0")}${Math.round(b * factor).toString(16).padStart(2, "0")}`;
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
  distanceUnit = "km",
  routePolyline,
  selected,
  pathColor,
  dimmed,
  timingWarning,
  recalculating,
  pixelDistance,
  fromNodeName,
  toNodeName,
  onClick,
}: EdgePolylineProps) {
  const map = useMap();
  const geometryLib = useMapsLibrary("geometry");
  const markerLib = useMapsLibrary("marker");
  const polylineRef = useRef<google.maps.Polyline | null>(null);
  const casingRef = useRef<google.maps.Polyline | null>(null);
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
  const directionSpanRef = useRef<HTMLSpanElement | null>(null);

  // Animated opacity state for dimmed transitions
  const currentOpacityRef = useRef<number>(dimmed ? 0.12 : 0.85);
  const animFrameRef = useRef<number>(0);
  const shimmerFrameRef = useRef<number>(0);

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

  // Derived visual properties
  const fillColor = recalculating
    ? "#a1a1aa"
    : dimmed
      ? "#d4d4d8"
      : timingWarning
        ? "#d97706"
        : pathColor || MODE_COLORS[travelMode] || "#6b7280";
  const casingColor = recalculating
    ? "#d4d4d8"
    : dimmed
      ? "#a1a1a6"
      : timingWarning
        ? "#8a4d04"
        : pathColor
          ? darkenHex(pathColor)
          : CASING_COLORS[travelMode] || "#404040";
  const fillWeight = selected ? 4 : dimmed ? 1.5 : 2.5;
  const casingWeight = selected ? 7 : dimmed ? 3 : 4.5;
  const dash = dimmed ? undefined : MODE_DASH[travelMode];

  // Should we show the label? Only when nodes are far enough apart on screen
  const showLabel =
    !dimmed &&
    (travelTimeHours || timingWarning) &&
    (pixelDistance === undefined || pixelDistance >= MIN_PX_FOR_LABEL);

  // ---------------------------------------------------------------------------
  // Effect A: CREATE polylines (casing + fill + hit target) — only when map or
  // path changes. Visual options are set to initial values here but kept in sync
  // by Effect B. onClick is read through onClickRef.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!map) return;

    const initialOpacity = currentOpacityRef.current;
    const initialDash = dimmed ? undefined : MODE_DASH[travelMode];
    const initialFillColor = dimmed
      ? "#d4d4d8"
      : timingWarning
        ? "#d97706"
        : pathColor || MODE_COLORS[travelMode] || "#6b7280";
    const initialCasingColor = dimmed
      ? "#a1a1a6"
      : timingWarning
        ? "#8a4d04"
        : pathColor
          ? darkenHex(pathColor)
          : CASING_COLORS[travelMode] || "#404040";
    const initialFillWeight = selected ? 4 : dimmed ? 1.5 : 2.5;
    const initialCasingWeight = selected ? 7 : dimmed ? 3 : 4.5;
    const casingOpacity = Math.min(initialOpacity, dimmed ? 0.08 : 0.5);

    // Direction hint arrow on the casing layer (repeating, aligned with fill arrows)
    const singleArrow = pixelDistance !== undefined && pixelDistance < 160;
    const hint: google.maps.IconSequence = {
      icon: {
        path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
        scale: selected ? 3 : 2.5,
        strokeColor: initialCasingColor,
        strokeOpacity: dimmed ? 0.08 : 0.6,
        strokeWeight: 0.5,
        fillColor: initialCasingColor,
        fillOpacity: dimmed ? 0.08 : 0.6,
      },
      offset: "50%",
      repeat: singleArrow ? "0" : "160px",
    };

    // Casing polyline (wider, darker, rendered underneath)
    const casing = new google.maps.Polyline({
      path,
      strokeColor: initialCasingColor,
      strokeOpacity: casingOpacity,
      strokeWeight: initialCasingWeight,
      map,
      clickable: false,
      zIndex: 1,
      icons: [hint],
    });
    casingRef.current = casing;

    // Fill polyline (narrower, brighter, rendered on top)
    const fillArrows = dimmed ? [] : [buildFillArrows(initialFillColor, initialOpacity, !!selected, pixelDistance)];
    const polyline = new google.maps.Polyline({
      path,
      strokeColor: initialFillColor,
      strokeOpacity: initialDash ? 0 : initialOpacity,
      strokeWeight: initialFillWeight,
      map,
      clickable: !dimmed,
      zIndex: 2,
      icons: initialDash ? [] : fillArrows,
    });

    if (initialDash) {
      polyline.setOptions({
        strokeOpacity: 0,
        icons: [
          {
            icon: {
              path: "M 0,-1 0,1",
              strokeOpacity: initialOpacity,
              strokeColor: initialFillColor,
              scale: initialFillWeight,
            },
            offset: "0",
            repeat: `${initialDash[0] + initialDash[1]}px`,
          },
          ...fillArrows,
        ],
      });
    }

    polyline.addListener("click", (e: google.maps.MapMouseEvent) => {
      const ll = e.latLng;
      onClickRef.current?.(ll ? { lat: ll.lat(), lng: ll.lng() } : undefined);
    });
    polylineRef.current = polyline;

    // Invisible wide polyline for easier touch targeting
    const hitPoly = new google.maps.Polyline({
      path,
      strokeColor: "transparent",
      strokeOpacity: 0,
      strokeWeight: 20,
      map,
      clickable: !dimmed,
      zIndex: 3,
    });
    hitPoly.addListener("click", (e: google.maps.MapMouseEvent) => {
      const ll = e.latLng;
      onClickRef.current?.(ll ? { lat: ll.lat(), lng: ll.lng() } : undefined);
    });
    hitPolylineRef.current = hitPoly;

    return () => {
      casing.setMap(null);
      casingRef.current = null;
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
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const polyline = polylineRef.current;
    const casing = casingRef.current;
    if (!polyline) return;

    const currentOpacity = currentOpacityRef.current;
    const casingOpacity = Math.min(currentOpacity, dimmed ? 0.08 : 0.5);

    // Update casing + direction hint
    if (casing) {
      const hintOpacity = dimmed ? 0.08 : 0.6;
      const singleArrowB = pixelDistance !== undefined && pixelDistance < 160;
      const hint: google.maps.IconSequence = {
        icon: {
          path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
          scale: selected ? 3 : 2.5,
          strokeColor: casingColor,
          strokeOpacity: hintOpacity,
          strokeWeight: 0.5,
          fillColor: casingColor,
          fillOpacity: hintOpacity,
        },
        offset: "50%",
        repeat: singleArrowB ? "0" : "160px",
      };
      casing.setOptions({
        strokeColor: casingColor,
        strokeOpacity: casingOpacity,
        strokeWeight: casingWeight,
        icons: [hint],
      });
    }

    // Update fill
    const fillArrowsB = dimmed ? [] : [buildFillArrows(fillColor, currentOpacity, !!selected, pixelDistance)];
    if (dash) {
      polyline.setOptions({
        strokeColor: fillColor,
        strokeOpacity: 0,
        strokeWeight: fillWeight,
        clickable: !dimmed,
        icons: [
          {
            icon: {
              path: "M 0,-1 0,1",
              strokeOpacity: currentOpacity,
              strokeColor: fillColor,
              scale: fillWeight,
            },
            offset: "0",
            repeat: `${dash[0] + dash[1]}px`,
          },
          ...fillArrowsB,
        ],
      });
    } else {
      polyline.setOptions({
        strokeColor: fillColor,
        strokeOpacity: currentOpacity,
        strokeWeight: fillWeight,
        clickable: !dimmed,
        icons: fillArrowsB,
      });
    }

    // Update hit polyline clickability
    const hitPoly = hitPolylineRef.current;
    if (hitPoly) {
      hitPoly.setOptions({ clickable: !dimmed });
    }
  }, [fillColor, casingColor, fillWeight, casingWeight, dash, selected, dimmed, pixelDistance]);

  // ---------------------------------------------------------------------------
  // Opacity animation — animates dimmed transitions over 350ms.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const targetOpacity = dimmed ? 0.12 : 0.85;
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
      const casing = casingRef.current;

      if (polyline) {
        const currentDash = dimmed ? undefined : MODE_DASH[travelMode];
        if (currentDash) {
          const icons = polyline.get("icons") as google.maps.IconSequence[] | undefined;
          if (icons) {
            const updated = icons.map((seq) => ({
              ...seq,
              icon: { ...seq.icon, strokeOpacity: opacity },
            }));
            polyline.setOptions({ icons: updated as google.maps.IconSequence[] });
          }
        } else {
          polyline.setOptions({ strokeOpacity: opacity });
        }
      }

      // Animate casing opacity + hint arrow
      if (casing) {
        const casingOpacity = Math.min(opacity, dimmed ? 0.08 : 0.5);
        const hintOpacity = dimmed ? Math.min(opacity, 0.08) : 0.6;
        const icons = casing.get("icons") as google.maps.IconSequence[] | undefined;
        if (icons) {
          const updated = icons.map((seq) => ({
            ...seq,
            icon: { ...seq.icon, strokeOpacity: hintOpacity, fillOpacity: hintOpacity },
          }));
          casing.setOptions({ strokeOpacity: casingOpacity, icons: updated as google.maps.IconSequence[] });
        } else {
          casing.setOptions({ strokeOpacity: casingOpacity });
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
  // Shimmer animation for recalculating state — pulsing opacity on a sine wave.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!recalculating) {
      cancelAnimationFrame(shimmerFrameRef.current);
      return;
    }

    const PERIOD = 1200; // ms for one full cycle

    function shimmerTick(now: number) {
      const phase = (now % PERIOD) / PERIOD;
      const opacity = 0.30 + 0.25 * Math.sin(phase * Math.PI * 2);
      const casingOpacity = 0.12 + 0.13 * Math.sin(phase * Math.PI * 2);

      const polyline = polylineRef.current;
      const casing = casingRef.current;

      if (polyline) {
        const icons = polyline.get("icons") as google.maps.IconSequence[] | undefined;
        if (icons && icons.length > 0) {
          const updated = icons.map((seq) => ({
            ...seq,
            icon: { ...seq.icon, strokeOpacity: opacity },
          }));
          polyline.setOptions({ icons: updated as google.maps.IconSequence[] });
        } else {
          polyline.setOptions({ strokeOpacity: opacity });
        }
      }
      if (casing) {
        casing.setOptions({ strokeOpacity: casingOpacity });
      }
      if (badgeElRef.current) {
        badgeElRef.current.style.opacity = String(opacity + 0.15);
      }

      shimmerFrameRef.current = requestAnimationFrame(shimmerTick);
    }

    shimmerFrameRef.current = requestAnimationFrame(shimmerTick);

    return () => {
      cancelAnimationFrame(shimmerFrameRef.current);
    };
  }, [recalculating]);

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

    // Direction label: "PAR → LON"
    const dirSpan = document.createElement("span");
    dirSpan.style.cssText = "font-size:10px;font-weight:600;letter-spacing:0.02em;display:none";
    directionSpanRef.current = dirSpan;
    el.appendChild(dirSpan);

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

    // Stop map click propagation from the badge — no LatLng needed since
    // the badge belongs to a specific edge (no disambiguation)
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
      directionSpanRef.current = null;
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

    const badgeColor = recalculating
      ? "#a1a1aa"
      : timingWarning
        ? "#d97706"
        : MODE_COLORS[travelMode] || "#6b7280";
    const iconSvg = MODE_ICON_SVG[travelMode] ?? MODE_ICON_SVG["drive"];
    const durationStr = travelTimeHours ? formatDuration(travelTimeHours) : "";
    const distStr = formatDistance(distanceKm, distanceUnit);

    // Update warning indicator
    if (warnSpanRef.current) {
      warnSpanRef.current.textContent = timingWarning && !recalculating ? "!" : "";
      warnSpanRef.current.style.display = timingWarning && !recalculating ? "" : "none";
    }

    // Update mode icon — show spinner when recalculating
    if (iconWrapRef.current) {
      iconWrapRef.current.style.color = badgeColor;
      if (recalculating) {
        iconWrapRef.current.innerHTML = `<span style="display:inline-block;width:10px;height:10px;border:2px solid #d4d4d8;border-top-color:#71717a;border-radius:50%;animation:spin 1s linear infinite"></span>`;
      } else {
        iconWrapRef.current.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24">${iconSvg}</svg>`;
      }
    }

    // Update direction label
    if (directionSpanRef.current) {
      if (recalculating || !fromNodeName || !toNodeName) {
        directionSpanRef.current.style.display = "none";
      } else {
        const from = abbreviate(fromNodeName);
        const to = abbreviate(toNodeName);
        directionSpanRef.current.innerHTML =
          `${from} <span style="color:${badgeColor};margin:0 1px">\u2192</span> ${to}`;
        directionSpanRef.current.style.display = "";
        directionSpanRef.current.style.color = "#283030";
      }
    }

    // Update duration text
    if (durationSpanRef.current) {
      if (recalculating) {
        durationSpanRef.current.textContent = "Updating\u2026";
        durationSpanRef.current.style.color = "#71717a";
      } else {
        durationSpanRef.current.textContent = durationStr;
        durationSpanRef.current.style.color = timingWarning ? "#d97706" : "#283030";
      }
    }

    // Update distance text — hide when warning or recalculating
    if (distanceSpanRef.current) {
      const showDist = !!distStr && !timingWarning && !recalculating;
      distanceSpanRef.current.textContent = showDist ? distStr : "";
      distanceSpanRef.current.style.display = showDist ? "" : "none";
      // Also hide the separator when distance is hidden
      const sep = distanceSpanRef.current.previousSibling as HTMLElement | null;
      if (sep) sep.style.display = showDist ? "" : "none";
    }

    // Update box-shadow accent color and interactivity
    if (badgeElRef.current) {
      badgeElRef.current.style.boxShadow = `0 1px 6px rgba(0,0,0,0.16), inset 0 0 0 1.5px ${badgeColor}40`;
      badgeElRef.current.style.pointerEvents = dimmed || recalculating ? "none" : "auto";
      badgeElRef.current.style.cursor = dimmed || recalculating ? "default" : "pointer";
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
    dimmed,
    recalculating,
    timingWarning,
    travelMode,
    travelTimeHours,
    distanceKm,
    distanceUnit,
    midpoint,
    fromNodeName,
    toNodeName,
  ]);

  return null;
}
