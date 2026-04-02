# Data Model: DAG Timeline View

**Branch**: `002-dag-timeline-view` | **Date**: 2026-04-01

## Overview

The timeline view introduces **no new persisted entities**. All data comes from existing `Node` and `Edge` Firestore documents via existing real-time hooks (`useTripNodes`, `useTripEdges`). The timeline is a purely computed visual representation.

This document defines the **computed types** used by the layout algorithm and component tree.

## Existing Entities (consumed, not modified)

### NodeData (from Firestore)

| Field | Type | Timeline usage |
|-------|------|---------------|
| `id` | `string` | Unique key for positioning and selection |
| `name` | `string` | Displayed in node block |
| `type` | `string` (city/hotel/restaurant/place/activity) | Color coding and icon |
| `lat_lng` | `{ lat: number; lng: number } \| null` | Not used in timeline |
| `arrival_time` | `string \| null` (ISO 8601 UTC) | Y-position calculation |
| `departure_time` | `string \| null` (ISO 8601 UTC) | Block height calculation |
| `order_index` | `number` | Tiebreaker for equal times |
| `participant_ids` | `string[] \| null` | Lane assignment |
| `timezone` | `string \| null` (IANA) | Display formatting |

### EdgeData (from Firestore)

| Field | Type | Timeline usage |
|-------|------|---------------|
| `id` | `string` | Unique key for selection |
| `from_node_id` | `string` | Connector placement |
| `to_node_id` | `string` | Connector placement |
| `travel_mode` | `string` (drive/flight/transit/walk) | Connector line style |
| `travel_time_hours` | `number` | Connector height, timing warning |
| `distance_km` | `number \| null` | Display in connector |

## Computed Types (new, frontend-only)

### TimelineZoomLevel

```typescript
type TimelineZoomLevel = 0 | 1 | 2 | 3 | 4;
```

Maps to pixels-per-hour: `[8, 16, 32, 60, 120]`. Default: `2` (32 px/h).

### PositionedNode

Represents a node's computed position in the timeline layout.

| Field | Type | Description |
|-------|------|-------------|
| `nodeId` | `string` | Reference to source NodeData |
| `yOffsetPx` | `number` | Vertical position from timeline top |
| `heightPx` | `number` | Block height (min 56px) |
| `laneIndex` | `number` | Horizontal lane (0-based) |
| `hasMissingTime` | `boolean` | True if arrival or departure was missing |
| `isInterpolated` | `boolean` | True if times were inferred from neighbors |
| `resolvedArrival` | `Date \| null` | Actual or inferred arrival |
| `resolvedDeparture` | `Date \| null` | Actual or inferred departure |

### PositionedEdge

Represents an edge's computed position in the timeline layout.

| Field | Type | Description |
|-------|------|-------------|
| `edgeId` | `string` | Reference to source EdgeData |
| `fromNodeId` | `string` | Source node |
| `toNodeId` | `string` | Target node |
| `connectorHeightPx` | `number` | Vertical space for connector (min 40px) |
| `hasTimingWarning` | `boolean` | True if timing conflict detected |

### LaneLayout

Represents one vertical column in the timeline (one participant path or the combined "all" view).

| Field | Type | Description |
|-------|------|-------------|
| `laneId` | `string` | Participant ID or `"__all__"` |
| `participantLabel` | `string \| null` | Display name for lane header |
| `nodeSequence` | `string[]` | Ordered node IDs in this lane |
| `positionedNodes` | `Map<string, PositionedNode>` | Keyed by nodeId |
| `positionedEdges` | `Map<string, PositionedEdge>` | Keyed by edgeId |
| `gapRegions` | `GapRegion[]` | Compressed gap segments |

### GapRegion

Represents a compressed idle period in the timeline.

| Field | Type | Description |
|-------|------|-------------|
| `afterNodeId` | `string` | The node before the gap |
| `compressedHeightPx` | `number` | Fixed 40px |
| `realDurationHours` | `number` | Actual gap duration for label |

### DateMarker

Represents a date label in the gutter.

| Field | Type | Description |
|-------|------|-------------|
| `yOffsetPx` | `number` | Vertical position for the label |
| `label` | `string` | Formatted date string (e.g., "Mon 14") |
| `isToday` | `boolean` | Highlights current day |

### TimelineLayout

Top-level output of the layout algorithm.

| Field | Type | Description |
|-------|------|-------------|
| `lanes` | `LaneLayout[]` | All lanes to render |
| `dateMarkers` | `DateMarker[]` | Date labels for gutter |
| `totalHeightPx` | `number` | Total scroll height |
| `missingTimeNodeIds` | `Set<string>` | Nodes needing time warnings |
| `timingConflictEdgeIds` | `Set<string>` | Edges with timing issues |

### ViewMode

```typescript
type ViewMode = "map" | "timeline";
```

State variable in `page.tsx` controlling which view is visible.

## Relationships

```
NodeData (Firestore) ──> PositionedNode (computed)
    │                          │
    │ participant_ids          │ laneIndex
    │                          │
    ▼                          ▼
PathResult (existing)    LaneLayout (computed)
    │                          │
    │ paths per user           │ nodeSequence + positionedEdges
    │                          │
    ▼                          ▼
EdgeData (Firestore) ──> PositionedEdge (computed)
                               │
                               ▼
                         TimelineLayout (computed)
                               │
                               ├── lanes[]
                               ├── dateMarkers[]
                               └── gapRegions[] (per lane)
```

## Validation Rules

1. `PositionedNode.heightPx >= 56` (enforced by layout algorithm)
2. `PositionedEdge.connectorHeightPx >= 40` (min touch target)
3. `GapRegion.realDurationHours > 8` (compression threshold)
4. `TimelineLayout.totalHeightPx` includes 80px bottom padding
5. Timing warning: `deficitMin > 10` (consistent with existing `selectedEdgeWarning` logic in page.tsx)

## State Transitions

No lifecycle/state transitions — all computed types are immutable snapshots recalculated on every input change via `useMemo`.
