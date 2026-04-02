# Component Interface Contracts: DAG Timeline View

**Branch**: `002-dag-timeline-view` | **Date**: 2026-04-01

## Overview

This document defines the public interfaces (props) for all new components. These contracts serve as the binding agreement between `page.tsx` (the consumer) and the timeline components (the providers).

No new API endpoints are introduced — all data comes from existing Firestore hooks.

## Component Tree

```
page.tsx
├── TimelineViewToggle          (in glass header)
└── TimelineView                (main content area)
    ├── TimelineDateGutter      (sticky left column)
    └── TimelineLane[]          (right column, one per lane)
        ├── TimelineNodeBlock[] (React.memo)
        └── TimelineEdgeConnector[] (React.memo)
```

## Contracts

### TimelineViewToggle

**File**: `frontend/components/timeline/timeline-view-toggle.tsx`

```typescript
interface TimelineViewToggleProps {
  viewMode: "map" | "timeline";
  onToggle: (mode: "map" | "timeline") => void;
}
```

**Behavior contract**:
- Renders a compact segmented pill with two options
- Active segment is visually highlighted (white background, bold text)
- Calls `onToggle` with the new mode when the inactive segment is tapped
- Does not manage any internal state

---

### TimelineView

**File**: `frontend/components/timeline/timeline-view.tsx`

```typescript
interface TimelineViewProps {
  // Data
  nodes: NodeData[];
  edges: EdgeData[];
  pathResult: PathResult | null;
  pathMode: "all" | "mine";
  currentUserId: string | null;
  participants: Record<string, { role: string; display_name?: string }>;

  // Selection
  selectedNodeId: string | null;
  selectedEdgeId: string | null;

  // Interaction callbacks
  onNodeSelect: (nodeId: string) => void;
  onEdgeSelect: (edgeId: string) => void;
  onInsertStop: (edgeId: string) => void;
  onAddNodeRequest: () => void;

  // Edit capability
  canEdit: boolean;

  // Display preferences
  datetimeFormat: "12h" | "24h";
  dateFormat: "eu" | "us" | "iso";
  distanceUnit: "km" | "mi";

  // Zoom
  zoomLevel: 0 | 1 | 2 | 3 | 4;
  onZoomChange: (level: 0 | 1 | 2 | 3 | 4) => void;
}
```

**Behavior contract**:
- Computes `TimelineLayout` via `useMemo` from nodes/edges/pathResult/zoomLevel
- Renders date gutter and lane columns in a CSS grid
- Scrolls to `selectedNodeId` when it changes (smooth scroll, `block: "center"`)
- Renders FAB at bottom-right when `canEdit` is true
- Renders zoom +/- control at right edge
- Shows empty state when `nodes.length === 0`
- Shows summary warning banner when 3+ nodes have missing times

---

### TimelineDateGutter

**File**: `frontend/components/timeline/timeline-date-gutter.tsx`

```typescript
interface TimelineDateGutterProps {
  dateMarkers: DateMarker[];
  totalHeightPx: number;
}
```

**Behavior contract**:
- Renders as a 56px-wide fixed column
- Each date label uses `position: sticky` to remain visible while scrolling through that day
- Today's date is highlighted in primary color with left accent border
- `React.memo` — only re-renders when `dateMarkers` reference changes

---

### TimelineLane

**File**: `frontend/components/timeline/timeline-lane.tsx`

```typescript
interface TimelineLaneProps {
  lane: LaneLayout;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onNodeSelect: (nodeId: string) => void;
  onEdgeSelect: (edgeId: string) => void;
  onInsertStop: (edgeId: string) => void;
  canEdit: boolean;
  datetimeFormat: "12h" | "24h";
  dateFormat: "eu" | "us" | "iso";
  distanceUnit: "km" | "mi";
  nodeBlockRefs: React.MutableRefObject<Map<string, HTMLElement>>;
}
```

**Behavior contract**:
- Renders blocks and connectors in sequence for one lane
- Inserts `GapRegion` indicators between blocks where compression applies
- Shows participant label at top of diverged section
- `React.memo` on `lane.laneId`, `selectedNodeId`, `selectedEdgeId`

---

### TimelineNodeBlock

**File**: `frontend/components/timeline/timeline-node-block.tsx`

```typescript
interface TimelineNodeBlockProps {
  nodeId: string;
  name: string;
  type: string;
  arrivalTime: string | null;
  departureTime: string | null;
  timezone?: string;
  heightPx: number;
  hasMissingTime: boolean;
  selected: boolean;
  dimmed: boolean;
  datetimeFormat: "12h" | "24h";
  dateFormat: "eu" | "us" | "iso";
  onSelect: (nodeId: string) => void;
  blockRef: (el: HTMLElement | null) => void;
}
```

**Behavior contract**:
- Renders a rounded card with height = `heightPx` (minimum 56px)
- Left accent border color determined by `type` (city=primary, hotel=purple, restaurant=tertiary, place=secondary, activity=error)
- Shows node type icon + name on first line, times on second line
- When `selected`: increased background opacity, thicker border, box shadow
- When `dimmed`: opacity 0.45 (for nodes outside current path filter)
- When `hasMissingTime`: amber "No time set" chip
- Registers with `blockRef` callback for scroll-to support
- `role="button"` with `aria-pressed={selected}`, keyboard accessible
- `React.memo` on `nodeId`, `selected`, `dimmed`, `heightPx`, `arrivalTime`, `departureTime`

---

### TimelineEdgeConnector

**File**: `frontend/components/timeline/timeline-edge-connector.tsx`

```typescript
interface TimelineEdgeConnectorProps {
  edgeId: string;
  travelMode: string;
  travelTimeHours: number;
  distanceKm: number | null;
  distanceUnit: "km" | "mi";
  connectorHeightPx: number;
  hasTimingWarning: boolean;
  selected: boolean;
  dimmed: boolean;
  canEdit: boolean;
  onSelect: (edgeId: string) => void;
  onInsertStop: (edgeId: string) => void;
}
```

**Behavior contract**:
- Renders a vertical connector with height = `connectorHeightPx` (minimum 40px)
- Line style varies by `travelMode`: drive=solid, flight=dashed, transit=tight-dashed, walk=dotted
- Shows travel mode icon (16px) and duration label
- Full-width tap target triggers `onSelect(edgeId)`
- When `hasTimingWarning`: line turns error color, warning icon replaces mode icon
- When `canEdit`: shows small "+" insert button (triggers `onInsertStop`)
- `React.memo` on `edgeId`, `selected`, `dimmed`, `connectorHeightPx`, `hasTimingWarning`

---

### TimelineEmptyState

**File**: `frontend/components/timeline/timeline-empty-state.tsx`

```typescript
interface TimelineEmptyStateProps {
  tripId: string;
}
```

**Behavior contract**:
- Shown when `nodes.length === 0`
- Centered illustration with "No stops yet" heading
- CTA linking to import page (`/trips/{tripId}/import`)

## Layout Algorithm Contract

### `computeTimelineLayout`

**File**: `frontend/lib/timeline-layout.ts`

```typescript
function computeTimelineLayout(
  nodes: NodeData[],
  edges: EdgeData[],
  pathResult: PathResult | null,
  pathMode: "all" | "mine",
  currentUserId: string | null,
  participantIds: string[],
  zoomLevel: 0 | 1 | 2 | 3 | 4,
  dateFormat: "eu" | "us" | "iso",
): TimelineLayout
```

**Contract**:
- Pure function, no side effects, no React dependencies
- Returns deterministic output for the same inputs
- Handles all edge cases: empty nodes, all missing times, single node, 50+ nodes
- Gap compression applied for idle periods > 8 hours
- Missing times interpolated from DAG neighbors where possible
- Date markers emitted at day boundaries in each node's timezone
- `totalHeightPx` includes 80px bottom padding

## Shared Utility Extraction

### ModeIcon (extract from EdgeDetail)

The travel mode icon rendering logic currently lives inline in `frontend/components/dag/edge-detail.tsx`. It must be extracted to a shared utility:

**File**: `frontend/components/dag/travel-mode-icon.tsx`

```typescript
interface TravelModeIconProps {
  mode: string;
  size?: number;  // default 18
  className?: string;
}
```

This is the only modification to an existing file required for this feature.
