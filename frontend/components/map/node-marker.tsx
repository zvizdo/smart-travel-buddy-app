"use client";

import { AdvancedMarker } from "@vis.gl/react-google-maps";

interface NodeMarkerProps {
  id: string;
  name: string;
  type: string;
  lat: number;
  lng: number;
  selected?: boolean;
  isMergeNode?: boolean;
  isStartNode?: boolean;
  dimmed?: boolean;
  /** Scale factor (0-1) for when nodes are too close together. Defaults to 1. */
  proximityScale?: number;
  /** True when the node has been displaced by fan-out. Hides the label to keep click targets tight. */
  fannedOut?: boolean;
  onClick?: (nodeId: string) => void;
}

export const TYPE_TOKENS: Record<string, { bg: string; glow: string }> = {
  city: { bg: "#006479", glow: "rgba(0,100,121,0.4)" },
  hotel: { bg: "#5e35b1", glow: "rgba(94,53,177,0.4)" },
  restaurant: { bg: "#6d5a00", glow: "rgba(109,90,0,0.4)" },
  place: { bg: "#006b1b", glow: "rgba(0,107,27,0.4)" },
  activity: { bg: "#b31b25", glow: "rgba(179,27,37,0.4)" },
};
export const FALLBACK_TOKEN = { bg: "#707978", glow: "rgba(112,121,120,0.4)" };

function NodeIcon({ type, dimmed, size = 16 }: { type: string; dimmed?: boolean; size?: number }) {
  const s = {
    stroke: dimmed ? "#9ca3af" : "#fff",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    fill: "none",
    width: size,
    height: size,
  };
  switch (type) {
    case "city":
      return (
        <svg viewBox="0 0 24 24" {...s}>
          <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" />
          <path d="M6 12H4a2 2 0 0 0-2 2v8h4M18 9h2a2 2 0 0 1 2 2v11h-4" />
          <path d="M10 6h4M10 10h4M10 14h4M10 18h4" />
        </svg>
      );
    case "hotel":
      return (
        <svg viewBox="0 0 24 24" {...s}>
          <path d="M2 20v-8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8" />
          <path d="M4 10V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4" />
          <path d="M12 10v4M2 16h20" />
        </svg>
      );
    case "restaurant":
      return (
        <svg viewBox="0 0 24 24" {...s}>
          <path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2M7 2v20" />
          <path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3ZM21 15v7" />
        </svg>
      );
    case "activity":
      return (
        <svg viewBox="0 0 24 24" {...s}>
          <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
        </svg>
      );
    default:
      // place — map pin
      return (
        <svg viewBox="0 0 24 24" {...s}>
          <path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" />
          <circle cx="12" cy="10" r="3" />
        </svg>
      );
  }
}

export function NodeMarker({
  id,
  name,
  type,
  lat,
  lng,
  selected,
  isMergeNode,
  isStartNode,
  dimmed,
  proximityScale = 1,
  fannedOut,
  onClick,
}: NodeMarkerProps) {
  const token = TYPE_TOKENS[type] ?? FALLBACK_TOKEN;
  const badgeBg = dimmed ? "#d1d5db" : token.bg;
  const isCompact = proximityScale < 0.85;
  const badgeSize = Math.round(34 * proximityScale);
  const iconSize = Math.round(16 * proximityScale);

  let shadow =
    "0 2px 8px rgba(0,0,0,0.28), 0 0 0 2px rgba(255,255,255,0.9)";
  if (selected) {
    shadow = `0 0 0 3px #fff, 0 0 0 6px ${token.bg}, 0 0 14px 5px ${token.glow}, 0 2px 8px rgba(0,0,0,0.3)`;
  } else if (isMergeNode && !dimmed) {
    shadow =
      "0 0 0 2.5px #fff, 0 0 0 5px #fdd400, 0 2px 8px rgba(0,0,0,0.28)";
  }

  const typeLabel =
    type === "city"
      ? "City"
      : type === "hotel"
        ? "Hotel"
        : type === "restaurant"
          ? "Restaurant"
          : type === "activity"
            ? "Activity"
            : "Place";

  // Whether the label/tail/merge dot/start pip should be visible
  const labelVisible = !dimmed && !isCompact && !fannedOut;
  const mergeVisible = isMergeNode && !dimmed && !isCompact;
  const startVisible = isStartNode && !dimmed && !isCompact;

  return (
    <AdvancedMarker position={{ lat, lng }} zIndex={selected ? 110 : 100} onClick={dimmed ? undefined : () => onClick?.(id)}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 3,
          cursor: dimmed ? "default" : "pointer",
          // Let clicks pass through to elements below (edges/labels) in the
          // invisible areas. Children re-enable pointer events selectively.
          pointerEvents: "none",
        }}
        role="button"
        tabIndex={dimmed ? -1 : 0}
        aria-label={`${name}, ${typeLabel}${isStartNode ? ", starting point" : ""}${isMergeNode ? ", junction point" : ""}`}
        onKeyDown={(e) => {
          if (dimmed) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick?.(id);
          }
        }}
      >
        {/* Name label — glass chip with colored left border.
            Always rendered; opacity transition drives show/hide. */}
        <div
          style={{
            background: "rgba(255,255,255,0.90)",
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
            borderRadius: 8,
            padding: "2px 8px 2px 6px",
            fontSize: 11,
            fontWeight: 600,
            color: "#283030",
            maxWidth: 110,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            boxShadow: "0 1px 4px rgba(0,0,0,0.12)",
            letterSpacing: "-0.01em",
            lineHeight: 1.6,
            borderLeft: `3px solid ${token.bg}`,
            opacity: labelVisible ? 1 : 0,
            pointerEvents: labelVisible ? "auto" as const : "none" as const,
            transition: "opacity 0.35s ease",
          }}
        >
          {name}
        </div>

        {/* Icon badge (circle) — re-enables pointer events so it is clickable */}
        <div
          style={{
            width: badgeSize,
            height: badgeSize,
            borderRadius: "50%",
            background: badgeBg,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: shadow,
            transition: "opacity 0.35s ease, background-color 0.35s ease, box-shadow 0.18s ease, transform 0.14s ease, width 0.15s ease, height 0.15s ease",
            transform: selected ? "scale(1.14)" : "scale(1)",
            opacity: dimmed ? 0.35 : 1,
            position: "relative",
            pointerEvents: dimmed ? "none" : "auto",
            cursor: dimmed ? "default" : "pointer",
          }}
        >
          <NodeIcon type={type} dimmed={dimmed} size={iconSize} />

          {/* Start indicator pip — top-left badge (green chevron).
              Always rendered; opacity transition drives show/hide. */}
          <div
            style={{
              position: "absolute",
              top: -4,
              left: -4,
              width: 14,
              height: 14,
              borderRadius: "50%",
              background: "#16a34a",
              border: "2px solid #fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              opacity: startVisible ? 1 : 0,
              transition: "opacity 0.35s ease",
              pointerEvents: "none",
            }}
          >
            <svg width="7" height="7" viewBox="0 0 8 8" fill="none">
              <path
                d="M2.5 1.5L5.5 4L2.5 6.5"
                stroke="#fff"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>

          {/* Merge indicator dot — top-right badge.
              Always rendered; opacity transition drives show/hide. */}
          <div
            style={{
              position: "absolute",
              top: -4,
              right: -4,
              width: 13,
              height: 13,
              borderRadius: "50%",
              background: "#fdd400",
              border: "2px solid #fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              opacity: mergeVisible ? 1 : 0,
              transition: "opacity 0.35s ease",
              pointerEvents: "none",
            }}
          >
            <svg width="7" height="7" viewBox="0 0 8 8" fill="none">
              <path
                d="M2 1.5L4 4L6 1.5M4 4V6.5"
                stroke="#594a00"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>

        {/* Pin tail.
            Always rendered; opacity transition drives show/hide. */}
        <div
          style={{
            width: 0,
            height: 0,
            borderLeft: "5px solid transparent",
            borderRight: "5px solid transparent",
            borderTop: `7px solid ${badgeBg}`,
            marginTop: -5,
            filter: "drop-shadow(0 2px 2px rgba(0,0,0,0.16))",
            opacity: labelVisible ? 1 : 0,
            transition: "opacity 0.35s ease",
          }}
        />
      </div>
    </AdvancedMarker>
  );
}
