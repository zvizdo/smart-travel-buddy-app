# Time Inference & Flex Timing

## `enrich_dag_times()` (`shared/shared/dag/time_inference.py`)

Pure forward-only topological enrichment fills `arrival_time` / `departure_time` / `duration_minutes` for flex nodes, flags `arrival_time_estimated` / `timing_conflict` / `drive_cap_warning` / `hold_reason`.

- Night rule (`no_drive_window`) overlaps are correctly calculated via local timezone intervals explicitly projecting bounds covering `day - 1` to capture morning overlaps.
- Drive-hour resets accurately observe `type ∈ {hotel, city}`, explicit duration over 6h, OR when local timezone `arrival.date()` diverges from `departure.date()`.
- Max drive cap rules and topology propagations track branches independently via `max(acc)`. Overlapping warnings correctly trigger on the recipient node even if the recipient is a rest node. Drive segment rendering uses DFS traversal to identify which historical branch exceeded the cap.
- Deterministic, no I/O. TS mirror: `frontend/lib/time-inference.ts`. Parity fixture: `shared/tests/fixtures/time_inference_cases.json`, consumed by both suites. Shared helpers in `_internals.py`.

## Flex Timing Model

Three shapes derived at read time — **time-bound** (arrival + departure), **mixed-bound** (one of them + duration), **duration-bound** (duration only). `is_start` / `is_end` are topology-derived, not stored. Estimated times are computed by `enrich_dag_times`, never persisted. Forward-only cascade from start node's user-set departure; downstream time-bound nodes surface mismatches as `timing_conflict` warnings (no back-propagation).

Rest nodes (`type ∈ {hotel, city}` or `duration_minutes >= 360`) reset the drive-hour counter. Null-timezone nodes skip the night rule (logged once). `TimingFieldsSection` is the shared controlled component for timing input — used by both `CreateNodeForm` (defaults: Flexible 120 min, anchor "none"/Float) and `NodeEditForm` (which infers initial mode/anchor from existing node data and shows a live impact panel memoized via `enrichDagTimes`).

## Merge-Node Per-Branch Arrivals

When a node has ≥2 incoming edges whose computed arrivals differ by more than 60 s (`_CONFLICT_TOLERANCE_SECONDS`), `enrich_dag_times` additionally emits `per_parent_arrivals: { edge_key: iso_string }` on the enriched node dict (edge_key = `edge.id` when present, else `"{from_node_id}->{to_node_id}"`; Python + TS must agree on the key). `arrival_time` stays as `max()` — the right quantity for drive-cap accumulation, conflict detection, and "when can the joint activity start" semantics.

The new dict powers two consumers:
1. `format_trip_context` renders a `🔀 per-branch arrivals:` block under the stop using the source-node name (`via Little Bighorn: ~16:28`) so MCP agents see the same truth the UI does.
2. `frontend/lib/timeline-layout.ts` shifts a lane's block TOP up to its per-parent arrival Y when that lane arrived earlier, keeping the BOTTOM at the joint-departure Y (so cross-lane departure alignment is preserved and overnight stays render visibly).

`TimelineLane` passes `pos.laneArrivalTime ?? node.arrival_time` to `TimelineNodeBlock`; `arrivalEstimated` is forced `true` when the override applies (per-branch times are always derived). Parity locked by shared fixture cases `merge_node_with_divergent_parent_arrivals` (emit) and `merge_node_parents_arrive_within_tolerance` (suppress within tolerance). Also guarded by `shared/tests/test_trip_context.py`, the per-lane describe block in `frontend/lib/timeline-layout.test.ts`, and `shared/tests/test_time_inference.py::TestPerParentArrivals` (60 s boundary + edge-id key format + single-parent suppression).
