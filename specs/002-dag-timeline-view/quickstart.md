# Quickstart: DAG Timeline View

**Branch**: `002-dag-timeline-view` | **Date**: 2026-04-01

## Prerequisites

- `pnpm` installed
- Frontend dev server running: `cd frontend && pnpm dev`
- A trip with 3+ nodes (some with times, some without) for meaningful testing

## Implementation Order

This feature is frontend-only. No backend changes required.

### Phase 1: Foundation (layout algorithm + basic rendering)

1. **`frontend/lib/timeline-layout.ts`** — Pure layout algorithm
   - Start here. This is testable without any UI.
   - Write `computeTimelineLayout()` and its types.
   - Write unit tests in `frontend/lib/__tests__/timeline-layout.test.ts`.

2. **`frontend/components/timeline/timeline-node-block.tsx`** — Node card
   - Simple presentational component.
   - Extract `ModeIcon` from `edge-detail.tsx` into `travel-mode-icon.tsx` first.

3. **`frontend/components/timeline/timeline-edge-connector.tsx`** — Edge connector
   - CSS-only vertical connector.

4. **`frontend/components/timeline/timeline-date-gutter.tsx`** — Date labels
   - Sticky positioning for day labels.

5. **`frontend/components/timeline/timeline-lane.tsx`** — Lane container
   - Composes node blocks + edge connectors in sequence.

6. **`frontend/components/timeline/timeline-view.tsx`** — Root container
   - Scrollable container, calls layout algorithm, renders lanes + gutter.
   - Includes FAB and zoom controls.

### Phase 2: Integration (wire into page.tsx)

7. **`frontend/components/timeline/timeline-view-toggle.tsx`** — Header pill
   - Map | Timeline segmented control.

8. **`frontend/app/trips/[tripId]/page.tsx`** — Wire it up
   - Add `viewMode` and `timelineZoom` state.
   - Add `TimelineViewToggle` to glass header.
   - Conditional rendering: TripMap (hidden when timeline) + TimelineView (hidden when map).
   - Pass existing callbacks to TimelineView.

### Phase 3: Polish (interactions, edge cases, zoom)

9. Scroll-to-selected-node behavior
10. Gap compression with expand/collapse
11. Missing time warnings and summary banner
12. Timing conflict indicators
13. Empty states (no nodes, all missing times)
14. Zoom +/- control and level transitions
15. Parallel lane rendering for diverging paths
16. "More paths" indicator for 4+ lanes

## Key Files to Read First

Before writing any code, read these files to understand existing patterns:

```
frontend/app/trips/[tripId]/page.tsx        # Main trip page, all state and callbacks
frontend/lib/path-computation.ts            # Lane assignment algorithm
frontend/components/map/trip-map.tsx         # How the map view is structured
frontend/components/dag/node-detail-sheet.tsx # How node detail works
frontend/components/dag/edge-detail.tsx      # How edge detail works (+ ModeIcon to extract)
frontend/lib/dates.ts                       # Date formatting utilities
frontend/lib/firestore-hooks.ts             # Data hooks
```

## Running Tests

```bash
cd frontend
pnpm test                    # Run all tests
pnpm test timeline-layout    # Run layout algorithm tests only
pnpm test:watch              # Watch mode during development
```

## Verification Checklist

After implementation, verify:

- [ ] View toggle switches between map and timeline without data loss
- [ ] Node selection syncs across views (select on timeline, switch to map, node still selected)
- [ ] Tapping a node block opens NodeDetailSheet
- [ ] Tapping an edge connector opens EdgeDetail
- [ ] FAB opens AddNodeSheet in search-first mode
- [ ] Insert stop from edge detail works in timeline
- [ ] Missing time warnings appear on untimed nodes
- [ ] Gap compression activates for 8h+ idle periods
- [ ] Zoom +/- changes timeline scale
- [ ] Parallel lanes render for diverging paths
- [ ] Path filter affects lane visibility
- [ ] Empty state shown when no nodes
- [ ] Offline banner disables FAB
- [ ] All touch targets >= 44px on 390px screen
