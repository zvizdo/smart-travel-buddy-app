# Timeline Reference

## Timeline Layout Engine (`lib/timeline-layout.ts`)

Pure `computeTimelineLayout()` — no React. Takes nodes, edges, path result, zoom; returns `TimelineLayout` with lanes, date markers, total height. **Lane strategy** (`determineLanes`): "mine" = single lane scoped to current user's path; "all" = topology-based — if DAG has branches (out-degree>=2 or multiple roots), `computeTopologyLanes()` maps every distinct topological path to a lane, labels from `participant_ids`; fallback is a single `__all__` lane. **Multi-lane alignment**: a single shared `time_to_Y_map` built from every lane's unique pinning timestamps — per-lane loops look up from this global map so shared nodes land at identical Y offsets by construction. **Shared nodes** in 2+ lanes get `isShared=true`; `sharedNodeRole` is `"diverge"` (out-degree>=2) or `"merge"` (in-degree>=2), rendered as "Paths split"/"Paths rejoin" chips. Frontend path computation (`lib/path-computation.ts`) mirrors `shared/shared/dag/paths.py`.

## Timeline Zoom

7 levels (0-6), `PX_PER_HOUR` = [2, 4, 8, 16, 32, 60, 120] scales the baseline `pxPerMinute`. Default zoom 2. Scroll position anchored on zoom change so content stays centered. Zoom only scales the baseline rate — there is no calibration ceiling in Sweep-and-Stretch, and the non-overlap guarantee comes from the stretch claims (below), not from zoom. At low zoom the min-height claims dominate (lots of short-stop blocks stacked at MIN_NODE_HEIGHT); at high zoom baseline wins and time reads as honest wall-clock scale.

## Sweep-and-Stretch Layout Algorithm

The timeline uses a global Sweep-and-Stretch pass to produce a single shared `time_to_Y_map`:

1. **Collect pinning timestamps** from every lane — per-lane arrival (using the `per_parent_arrivals` override when set, so each lane's block TOP anchors to its own arrival at a merge node), node departure (shared), and midnight boundaries in the primary timezone strictly inside trip bounds.
2. **Build intervals** between consecutive timestamps with baseline height `deltaMin × basePxPerMin`.
3. **Compress idle intervals** — any interval where no lane has a node actively spanning it AND duration ≥ 8 h (`IDLE_COMPRESSION_THRESHOLD_MS`) collapses to `IDLE_COMPRESSED_PX = 40`. This catches both empty calendar days (each one becomes its own 40 px row with a date marker) and long mid-day downtime uniformly.
4. **Apply stretch claims** — ≥ constraints that grow intervals in their range proportionally to their duration:
   - Node span `[arr, dep] ≥ MIN_NODE_HEIGHT_PX (56)` for every node with a departure.
   - Edge span `[from.dep || from.arr, to.arr] ≥ MIN_CONNECTOR_HEIGHT_PX (40)` for every edge.
   - Consecutive-pair `[A.arr, B.arr] ≥ MIN_NODE + (edge ? MIN_CONNECTOR : 0)` for every pair of consecutive lane nodes. **This is the no-overlap guarantee** — regardless of A's duration or B's arrival, A's block plus the connector cannot exceed the time-to-Y distance to B.
5. **Accumulate** interval heights into `time_to_Y_map`.

Node Y = `timeToY(arrival)`. Node height = `max(MIN_NODE, timeToY(departure) - timeToY(arrival))`. Because the map is shared, shared nodes land at identical Y in every lane; merge nodes with divergent per-parent arrivals render with different TOPs per lane while their shared BOTTOM (joint departure) still aligns. Time is non-linear within a day (stretched intervals tick faster than baseline) but the "same Y = same wall-clock time in every lane" invariant holds strictly. Guarded by "per-day rate sizing (no overlap invariant)" and "per-lane arrival for shared merge nodes" describe blocks in `frontend/lib/timeline-layout.test.ts`.

## Timeline Node-Block Sticky Content

Because overnight and long-activity blocks can render very tall (600+ px), `TimelineNodeBlock`'s content uses `sticky top-16` so the icon + name + time row stays visible at the top of the viewport as the user scrolls through the block. Without this, tall blocks show `justify-center`-positioned text in the middle — invisible when the user is at the block's top or bottom, making overnights look like empty colored stripes.

## Drive-Cap Advisory Min Height

Nodes with `drive_cap_warning: true` render a third row inside the block ("Drive cap — add rest stop" or "Night drive — add rest stop"). The layout engine uses `MIN_NODE_HEIGHT_WITH_ADVISORY_PX = 76` (vs. the baseline `MIN_NODE_HEIGHT_PX = 56`) as the floor and in the consecutive-pair claim so the label stays inside the rounded border at every zoom. Non-advisory nodes keep the 56 px floor.

## Timeline Lane IDs

"all" mode always emits `topology-N` lane IDs via `computeTopologyLanes()`, with participant names surfaced in `participantLabel`, not `laneId`. "mine" mode uses the `currentUserId` as the lane ID. There is no code path that keys lanes by participant ID in "all" mode — a stale test used to assert otherwise.

## Memo Comparator Discipline

`TimelineNodeBlock` and `TimelineLane` use custom `memo()` comparators. Every prop the component reads must be in the comparator, or Firestore updates to that field render stale UI. `TimelineLane`'s comparator covers `lane`, `selectedNodeId`, `selectedEdgeId`, `dimmedNodeIds`, `nodes`, `edges`, `canEdit`, `datetimeFormat`, `dateFormat`, `distanceUnit`. `TimelineNodeBlock`'s comparator covers `type`, `timezone`, `name`, `datetimeFormat`, `dateFormat`, and the flex-timing flags (`arrivalEstimated`, `departureEstimated`, `overnightHold`, `timingConflict`, `spansDays`). When adding a prop, also add it to the comparator.
