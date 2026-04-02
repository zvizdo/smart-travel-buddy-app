# Tasks: DAG Timeline View

**Input**: Design documents from `/specs/002-dag-timeline-view/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Not explicitly requested in the feature specification. Test tasks are omitted.

**Organization**: Tasks are grouped by user story (P1-P5 from spec.md) to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Frontend**: `frontend/` — Next.js application
- All new components: `frontend/components/timeline/`
- Layout algorithm: `frontend/lib/timeline-layout.ts`
- Modified files: `frontend/app/trips/[tripId]/page.tsx`, `frontend/components/dag/edge-detail.tsx`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Extract shared utilities and define computed types needed by all timeline components

- [x] T001 Extract `TravelModeIcon` component from `frontend/components/dag/edge-detail.tsx` into `frontend/components/dag/travel-mode-icon.tsx` — move the inline mode icon rendering logic to a shared component with props `{ mode: string; size?: number; className?: string }`, then update `edge-detail.tsx` to import and use the extracted component
- [x] T002 Define all computed TypeScript types (`TimelineZoomLevel`, `PositionedNode`, `PositionedEdge`, `LaneLayout`, `GapRegion`, `DateMarker`, `TimelineLayout`) as exports in `frontend/lib/timeline-layout.ts` per the data-model.md specification — types only, no algorithm implementation yet

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Implement the core layout algorithm that ALL user stories depend on. This pure function computes node positions, connector heights, and date markers from raw Firestore data.

**CRITICAL**: No user story work can begin until this phase is complete.

- [x] T003 Implement `computeTimelineLayout()` in `frontend/lib/timeline-layout.ts` — the 9-step pure function: (1) determine active lanes from `pathResult` and `pathMode`, (2) resolve missing times by interpolation from DAG neighbors, (3) compute px/ms scale from zoom level `[8, 16, 32, 60, 120]` px/hour, (4) compute `yOffsetPx` for each node from arrival_time, (5) compute `heightPx` from duration with min 56px, (6) detect and compress gaps >8h to fixed 40px, (7) compute connector heights with min 40px, (8) detect timing warnings where deficit >10 min, (9) compute date markers at day boundaries using `formatDate` from `frontend/lib/dates.ts`. Handle edge cases: empty nodes array, all missing times (orphan stacking at 72px intervals), single node. Use `computeParticipantPaths` from `frontend/lib/path-computation.ts` for lane assignment.

**Checkpoint**: Layout algorithm complete — all stories can now build on it.

---

## Phase 3: User Story 1 — View Trip Schedule as Timeline (Priority: P1) MVP

**Goal**: Users can switch to a timeline view and see all trip stops laid out vertically from top to bottom, with height proportional to duration, dates on the left, and travel segments between stops.

**Independent Test**: Create a trip with 5+ nodes that have arrival and departure times, switch to timeline view, verify all nodes appear in chronological order with proportional heights and date labels.

### Implementation for User Story 1

- [x] T004 [P] [US1] Create `TimelineNodeBlock` component in `frontend/components/timeline/timeline-node-block.tsx` — renders a rounded card (12px radius) with height from `heightPx` prop (min 56px), 3px left accent border color-coded by node type (city=primary, hotel=purple, restaurant=tertiary, place=secondary, activity=error), node type icon (reuse `TYPE_TOKENS` from `frontend/components/map/node-marker.tsx`) + name on first line, arrival/departure times on second line using `formatDateTime` from `frontend/lib/dates.ts`. Selected state: thicker border, box shadow, increased background opacity. Dimmed state: opacity 0.45. `React.memo` on `nodeId, selected, dimmed, heightPx, arrivalTime, departureTime`. Include `role="button"`, `aria-pressed={selected}`, keyboard `onKeyDown` for Enter/Space. Register with `blockRef` callback for scroll-to support.
- [x] T005 [P] [US1] Create `TimelineEdgeConnector` component in `frontend/components/timeline/timeline-edge-connector.tsx` — renders a vertical connector with height from `connectorHeightPx` prop (min 40px). CSS `border-left` with style varying by `travelMode`: drive=solid 2px, flight=dashed 2px (6px gap 4px), transit=dashed 2px (3px gap 3px), walk=dotted 2px. Shows `TravelModeIcon` (16px) centered and duration label (`text-[10px]`). Full-width tap target triggers `onSelect(edgeId)`. `React.memo` on `edgeId, selected, dimmed, connectorHeightPx, hasTimingWarning`.
- [x] T006 [P] [US1] Create `TimelineDateGutter` component in `frontend/components/timeline/timeline-date-gutter.tsx` — 56px fixed-width left column with `surface-low` background. Renders `DateMarker[]` as sticky day labels (`position: sticky; top: 60px`). Format: short day + date ("Mon 14"), `text-xs font-semibold text-on-surface-variant`. Today highlight: `text-primary` with 2px left border. `React.memo` on `dateMarkers` reference.
- [x] T007 [US1] Create `TimelineLane` component in `frontend/components/timeline/timeline-lane.tsx` — renders `TimelineNodeBlock` and `TimelineEdgeConnector` in sequence for one `LaneLayout`. Iterates `lane.nodeSequence`, looks up each node's `PositionedNode` and the edge connecting to the next node's `PositionedEdge`. Accepts `nodeBlockRefs` for scroll-to support. `React.memo` on `lane.laneId, selectedNodeId, selectedEdgeId`. (Depends on T004, T005)
- [x] T008 [US1] Create `TimelineView` root component in `frontend/components/timeline/timeline-view.tsx` — scrollable container (`overflow-y-auto`) with CSS grid layout: `TimelineDateGutter` (56px left column) + lane area (`flex-1` right column). Calls `computeTimelineLayout()` via `useMemo` on `[nodes, edges, pathResult, pathMode, currentUserId, participantIds, zoomLevel, dateFormat]`. Renders single `TimelineLane` for the primary lane. Manages `nodeBlockRefs` map via `useRef<Map<string, HTMLElement>>`. Scrolls to `selectedNodeId` on change via `useEffect` + `scrollIntoView({ behavior: "smooth", block: "center" })`. Container height = `totalHeightPx` from layout. (Depends on T006, T007)
- [x] T009 [P] [US1] Create `TimelineViewToggle` component in `frontend/components/timeline/timeline-view-toggle.tsx` — compact 68x28px segmented pill with "Map" and "Timeline" segments (icon + label for active, icon only for inactive). Active segment: white background, `rounded-[11px]`, box shadow, `font-semibold`. Inactive: transparent, `font-medium`. Map icon = map pin, Timeline icon = list/calendar. Calls `onToggle(mode)` on inactive segment tap. Sliding indicator animation: 150ms `cubic-bezier(0.4, 0, 0.2, 1)`.
- [x] T010 [US1] Integrate timeline into `frontend/app/trips/[tripId]/page.tsx` — add `viewMode` state (`useState<"map" | "timeline">("map")`), add `timelineZoom` state (`useState<TimelineZoomLevel>(2)`). Insert `TimelineViewToggle` in the glass header between plan switcher and notification bell area. Wrap `TripMap` in a div that applies `hidden` class when `viewMode === "timeline"`. Add `TimelineView` wrapped in a div that applies `hidden` class when `viewMode === "map"`. Pass existing state and callbacks to `TimelineView`: `nodes, edges, pathResult, pathMode, currentUserId, participants, selectedNodeId, selectedEdgeId, onNodeSelect: handleNodeSelect, onEdgeSelect: handleEdgeSelect, canEdit, datetimeFormat, dateFormat, distanceUnit, zoomLevel: timelineZoom, onZoomChange: setTimelineZoom`. Both views stay mounted (hidden preserves state). Pass `onInsertStop` and `onAddNodeRequest` as no-ops initially (wired in US2).

**Checkpoint**: Users can switch between map and timeline views. Timeline shows nodes in chronological order with proportional heights, date gutter, and edge connectors. Selection state is preserved across view switches.

---

## Phase 4: User Story 2 — Interact with Nodes and Edges on Timeline (Priority: P2)

**Goal**: Users can tap node blocks to open detail sheets, tap edge connectors to see travel info and insert stops, and use a FAB to add new nodes via search — full interaction parity with the map view.

**Independent Test**: Open timeline, tap a node block to confirm NodeDetailSheet opens, edit times, tap an edge connector and use "insert stop" to add a new node between two existing ones.

### Implementation for User Story 2

- [x] T011 [US2] Wire node block tap to `NodeDetailSheet` in `frontend/components/timeline/timeline-view.tsx` — ensure `onNodeSelect` callback from page.tsx triggers `setSelectedNodeId` which already opens `NodeDetailSheet`. Verify the sheet opens correctly over the timeline view (sheet uses `absolute bottom-[var(--bottom-nav-height)]` positioning which should overlay the timeline). No new code needed in `NodeDetailSheet` — validate the existing integration works.
- [x] T012 [US2] Wire edge connector tap to `EdgeDetail` in `frontend/components/timeline/timeline-view.tsx` — ensure `onEdgeSelect` callback triggers `setSelectedEdgeId` which opens `EdgeDetail` with travel mode, duration, distance, and "Insert stop here" button. Verify the sheet opens correctly over the timeline.
- [x] T013 [US2] Add `handleTimelineInsertStop` to `frontend/app/trips/[tripId]/page.tsx` — when in timeline mode, "Insert stop here" from EdgeDetail should open `AddNodeSheet` in search-first mode (no map tap needed). Create a handler that sets `insertEdgeId` and opens AddNodeSheet with `initialPlace` as null to trigger `PlacesAutocomplete` entry. Skip the "Tap the map to place your new stop" toast that the map-mode insert uses. Pass this handler as `onInsertStop` to `TimelineView` when `viewMode === "timeline"`.
- [x] T014 [US2] Add FAB (floating action button) to `frontend/components/timeline/timeline-view.tsx` — 56px diameter circle, `gradient-primary` background, white `+` icon (24px), positioned `fixed bottom-[72px] right-4 z-[25]` (56px nav + 16px gap). `shadow-[0px_12px_32px_-4px_rgba(0,100,121,0.12)]`. Disabled (opacity 50%, pointer-events none) when `canEdit === false`. Tap calls `onAddNodeRequest` which opens `AddNodeSheet` in search-first mode from page.tsx.
- [x] T015 [US2] Wire `onAddNodeRequest` in `frontend/app/trips/[tripId]/page.tsx` — set `addNodePlace` to a sentinel value (`{ name: "", placeId: "", lat: 0, lng: 0, types: [] }`) to open AddNodeSheet, which already renders `PlacesAutocomplete` when no valid place coordinates are provided. Pass this handler to `TimelineView`.

**Checkpoint**: Full interaction parity with map view. Tapping nodes opens detail sheet, tapping edges opens edge detail, insert stop works via search, FAB adds new nodes.

---

## Phase 5: User Story 3 — View Branching Paths as Parallel Lanes (Priority: P3)

**Goal**: Diverging participant paths appear as separate parallel lanes, merging when paths reconverge. Multiple root nodes show as parallel lanes from the top.

**Independent Test**: Create a trip with a divergence point (one node branching into two paths), switch to timeline, verify two lanes appear with correct nodes in each, merging back when paths rejoin.

### Implementation for User Story 3

- [x] T016 [US3] Extend `TimelineView` to render multiple `TimelineLane` components in `frontend/components/timeline/timeline-view.tsx` — when `layout.lanes.length > 1`, render lanes side by side in the lane area using flex layout. Each lane gets `flex: 1` with width distribution: 1 lane = 334px, 2 lanes = 167px each, 3 lanes = ~111px each. Add 1px `outline-variant` separators between adjacent lanes at 40% opacity.
- [x] T017 [US3] Add participant lane labels to `frontend/components/timeline/timeline-lane.tsx` — at the top of a diverged lane section, render a 24px-high label with `surface-low` background, `text-[10px] font-semibold text-on-surface-variant`, showing first names of participants on that path using `formatUserName()`. If no participants are assigned, show "Unassigned" in `text-outline-variant`.
- [x] T018 [US3] Add "more paths" indicator and horizontal scroll for 4+ lanes in `frontend/components/timeline/timeline-view.tsx` — when `layout.lanes.length > 3`, first 3 lanes render at ~111px width, remaining are clipped. Add a pill badge at right edge: `surface-high` background, `text-xs font-semibold`, "+N more paths" text. Lane area switches to `overflow-x-auto` with `scroll-snap-type: x mandatory`, `scroll-snap-align: start` on each lane. Date gutter remains `sticky left-0 z-10`.
- [x] T019 [US3] Integrate path filtering with lanes in `frontend/components/timeline/timeline-view.tsx` — when `pathMode === "mine"`, pass only the current user's lane to the layout or dim non-user lanes (opacity 0.45 on lane container). Ensure `PathFilter` component (already rendered by page.tsx when branches exist) controls `pathMode` state which flows into `TimelineView`.

**Checkpoint**: Parallel lanes render for diverging paths. Lanes merge at convergence points. 4+ lanes scroll horizontally. Path filter dims non-user lanes.

---

## Phase 6: User Story 4 — Handle Missing and Partial Times (Priority: P4)

**Goal**: Nodes without times are shown with clear warnings. Nodes with only arrival or departure get inferred counterparts. A summary warning surfaces when many nodes need times.

**Independent Test**: Create a trip with 3 nodes where the middle node has no times, switch to timeline, verify it appears with a "No time set" warning indicator.

### Implementation for User Story 4

- [x] T020 [US4] Add missing-time warning chip to `TimelineNodeBlock` in `frontend/components/timeline/timeline-node-block.tsx` — when `hasMissingTime` is true, render an amber chip below the time line: 16px height, `rounded-full`, background `rgba(253,212,0,0.15)`, warning triangle icon (10px) in `tertiary` color, text "No time set" in `text-[10px] font-medium`. For nodes with inferred times, use dashed border style on the inferred time display to visually distinguish from explicit times.
- [x] T021 [US4] Add untimed-nodes section to `TimelineLane` in `frontend/components/timeline/timeline-lane.tsx` — after all timed nodes, if any `PositionedNode` in the lane has `hasMissingTime && resolvedArrival === null`, render a dedicated "Untimed stops" section: dashed horizontal divider (`1px dashed outline-variant`), label "Untimed stops" in `text-[10px] font-medium text-on-surface-variant`, then stack untimed blocks at 56px height with 8px gaps.
- [x] T022 [US4] Add summary warning banner to `TimelineView` in `frontend/components/timeline/timeline-view.tsx` — when `layout.missingTimeNodeIds.size >= 3`, render a sticky banner at top of scroll container: full width, 40px height, `tertiary-container` background at 20% opacity, warning icon (16px), text "X stops are missing times — tap to review", down chevron. Tapping the banner smooth-scrolls to the untimed section. `position: sticky; top: 0; z-index: 8`.

**Checkpoint**: Untimed nodes clearly flagged. Inferred times visually distinct. Summary banner guides users to set missing times.

---

## Phase 7: User Story 5 — Navigate and Zoom the Timeline (Priority: P5)

**Goal**: Users can adjust zoom level to see more or fewer hours, and long idle gaps are compressed so they don't waste scroll space.

**Independent Test**: Create a 5-day trip, open timeline, zoom out to see all days, zoom in to see hourly detail, verify gap compression activates for overnight periods.

### Implementation for User Story 5

- [x] T023 [US5] Add zoom control to `TimelineView` in `frontend/components/timeline/timeline-view.tsx` — vertical pill with `+` and `-` buttons, positioned `fixed right-3 bottom-[136px] z-[25]` (above FAB). 32px wide, `surface-lowest/90` background, `shadow-soft`, `rounded-[20px]`. Each button 32x36px, `text-on-surface-variant`. Active press: `surface-high`, `scale(0.94)`, 100ms. Divider between buttons: 1px `surface-dim`. `+` calls `onZoomChange(Math.min(4, zoomLevel + 1))`, `-` calls `onZoomChange(Math.max(0, zoomLevel - 1))`. Zoom anchor: preserve the time value at the top of the viewport when zooming — calculate the time at the topmost pixel, apply new `px_per_hour`, scroll to the new pixel for that same time.
- [x] T024 [US5] Add gap compression indicators to `TimelineLane` in `frontend/components/timeline/timeline-lane.tsx` — when the layout contains `gapRegions` for this lane, render a 40px compressed gap indicator between the relevant blocks: `surface-low` background, 8px corner radius, dashed horizontal rules top and bottom (1px `surface-dim`), centered row with moon/sleep icon (14px `outline-variant`) + label "~Xh idle" or "~X days idle" in `text-[10px] font-medium text-on-surface-variant`. Make the indicator tappable: expand to full proportional height (200ms, `cubic-bezier(0.16, 1, 0.3, 1)`) with striped background. Show collapse chevron at top of expanded gap.
- [x] T025 [US5] Preserve scroll position across view switches in `frontend/components/timeline/timeline-view.tsx` — since both TripMap and TimelineView remain mounted (hidden via `display: none`), native DOM scroll position is automatically preserved. Verify this works. If the initial timeline entry needs special handling, add logic to scroll to today's date (if trip is in progress) or day 1 of the trip on first view switch only (track via `useRef` flag).

**Checkpoint**: Zoom +/- changes timeline scale smoothly. Gap compression reduces scroll for overnight stays. Scroll position preserved across view switches.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Edge cases, visual polish, and accessibility that affect multiple user stories

- [x] T026 [P] Create `TimelineEmptyState` component in `frontend/components/timeline/timeline-empty-state.tsx` — shown when `nodes.length === 0`. Centered layout: 64x64px icon (`rounded-2xl bg-primary/10`), heading "No stops yet" (`text-base font-bold`), subtext "Add your first stop to start building your timeline." (`text-sm text-on-surface-variant`), CTA button linking to `/trips/{tripId}/import` with `gradient-primary rounded-full` style. Integrate into `TimelineView` — render instead of gutter+lanes when nodes are empty.
- [x] T027 [P] Add timing conflict indicators to `TimelineNodeBlock` and `TimelineEdgeConnector` — in `frontend/components/timeline/timeline-node-block.tsx`: when the node is part of a timing conflict (check `layout.timingConflictEdgeIds`), override left border to 4px `error` (#b31b25) and add red chip "Timing conflict". In `frontend/components/timeline/timeline-edge-connector.tsx`: when `hasTimingWarning` is true, change connector line to `error` color, replace travel mode icon with warning triangle icon (14px).
- [x] T028 [P] Add current-time indicator to `TimelineView` in `frontend/components/timeline/timeline-view.tsx` — when the current time falls within the trip's date range, render a horizontal 1px red line (`error` color) spanning the full lane area width at the appropriate `yOffsetPx`. Small filled circle (6px diameter, `error`) at the left edge where the line meets the lane area. Rendered at `z-5` above node blocks.
- [x] T029 Add "all nodes missing times" fallback in `TimelineView` in `frontend/components/timeline/timeline-view.tsx` — when all nodes lack times, render them in topological order at 56px heights with equal spacing. Show escalated warning banner: `surface-high` background, `text-sm` (not 10px), text "All stops are missing times — add times to see the timeline". Date gutter shows no dates (or "—").
- [x] T030 Verify offline behavior — confirm `OfflineBanner` renders above timeline (existing `top-12 z-20` positioning). Confirm FAB is disabled when `canEdit === false` (which is false when offline). Confirm `DivergenceResolver` renders above timeline at `bottom-[var(--bottom-nav-height)] z-20`. No new code expected — verify existing absolute positioning works with the timeline scroll container.
- [x] T031 Run `quickstart.md` verification checklist — manually test all 14 items in the verification checklist against a trip with 5+ nodes, mixed timed/untimed, at least one divergence point, and a gap exceeding 8 hours.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on T002 (types defined) — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Phase 2 (layout algorithm) — MVP delivery point
- **US2 (Phase 4)**: Depends on US1 (timeline must render to test interactions)
- **US3 (Phase 5)**: Depends on US1 (single-lane rendering must work first)
- **US4 (Phase 6)**: Depends on US1 (node blocks must render to show warnings)
- **US5 (Phase 7)**: Depends on US1 (timeline must render to test zoom/compression)
- **Polish (Phase 8)**: Depends on US1 at minimum; ideally after all stories complete

### User Story Dependencies

- **US1 (P1)**: Can start after Phase 2 — no dependencies on other stories. **This is the MVP.**
- **US2 (P2)**: Depends on US1 (needs rendered timeline to tap). Can run in parallel with US3-US5 after US1 completes.
- **US3 (P3)**: Depends on US1 (needs basic lane rendering). Can run in parallel with US2, US4, US5 after US1 completes.
- **US4 (P4)**: Depends on US1 (needs node block component). Can run in parallel with US2, US3, US5 after US1 completes.
- **US5 (P5)**: Depends on US1 (needs timeline scroll container). Can run in parallel with US2, US3, US4 after US1 completes.

### Within Each User Story

- Components (node block, connector, gutter) before containers (lane, view)
- Containers before page.tsx integration
- Core rendering before interaction wiring

### Parallel Opportunities

- **Phase 1**: T001 and T002 can run in parallel
- **Phase 3 (US1)**: T004, T005, T006, T009 can all run in parallel (different files)
- **Phase 3 (US1)**: T007 depends on T004 + T005; T008 depends on T006 + T007
- **After US1 completes**: US2, US3, US4, US5 can all proceed in parallel (different concerns, minimal file overlap)
- **Phase 8**: T026, T027, T028 can all run in parallel (different files)

---

## Parallel Example: User Story 1

```bash
# Launch all leaf components in parallel (no dependencies between them):
Task T004: "Create TimelineNodeBlock in frontend/components/timeline/timeline-node-block.tsx"
Task T005: "Create TimelineEdgeConnector in frontend/components/timeline/timeline-edge-connector.tsx"
Task T006: "Create TimelineDateGutter in frontend/components/timeline/timeline-date-gutter.tsx"
Task T009: "Create TimelineViewToggle in frontend/components/timeline/timeline-view-toggle.tsx"

# Then sequentially:
Task T007: "Create TimelineLane (depends on T004, T005)"
Task T008: "Create TimelineView (depends on T006, T007)"
Task T010: "Integrate into page.tsx (depends on T008, T009)"
```

---

## Parallel Example: Post-US1 Stories

```bash
# After US1 is complete, all remaining stories can proceed in parallel:
Developer A: US2 (T011-T015) — Interaction parity
Developer B: US3 (T016-T019) — Parallel lanes
Developer C: US4 (T020-T022) — Missing times
Developer D: US5 (T023-T025) — Zoom & compression
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001-T002)
2. Complete Phase 2: Foundational layout algorithm (T003)
3. Complete Phase 3: User Story 1 (T004-T010)
4. **STOP and VALIDATE**: Switch between map and timeline, verify nodes render chronologically with proportional heights, dates show in gutter, connectors show between blocks
5. Deploy/demo — basic timeline is usable

### Incremental Delivery

1. Setup + Foundational → Layout algorithm ready
2. US1 → Basic timeline rendering → Deploy (MVP!)
3. US2 → Full interaction parity → Deploy (tap nodes/edges, FAB, insert stop)
4. US3 → Parallel lanes for branching paths → Deploy (group trip support)
5. US4 → Missing time handling → Deploy (graceful incomplete data)
6. US5 → Zoom & gap compression → Deploy (long trip ergonomics)
7. Polish → Edge cases, accessibility, timing conflicts → Final release

### Single Developer Strategy

Work sequentially through phases: Setup → Foundation → US1 → US2 → US3 → US4 → US5 → Polish. Each story adds value independently and can be shipped at any checkpoint.

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and testable after US1
- US1 is the critical path — everything else builds on it
- No backend changes required for any task
- Only 2 existing files modified: `page.tsx` (T010, T013, T015) and `edge-detail.tsx` (T001)
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
