# Research: DAG Timeline View

**Branch**: `002-dag-timeline-view` | **Date**: 2026-04-01

## Decision 1: View Toggle Placement

**Decision**: Compact two-segment pill (Map | Timeline) in the top glass header, between plan switcher and notification bell.

**Rationale**: UX evaluation of 5 options (bottom nav toggle, bottom nav segment, two separate nav items, header pill, dual FAB) concluded that the header pill is optimal because:
- Bottom nav is for primary navigation, not view mode switching
- Header placement follows established travel app patterns (Airbnb, Google Maps, Apple Maps)
- Does not disrupt existing bottom nav structure or z-index layering

**Alternatives considered**:
- Bottom nav toggle (confusing — icon meaning changes)
- Bottom nav segmented control (overloads the nav bar)
- Two separate bottom nav items (wastes space)
- Dual FAB (clutters the action area)

## Decision 2: Adding Nodes from Timeline (No Map Surface)

**Decision**: Floating Action Button (FAB) at bottom-right of timeline, opening AddNodeSheet in search-first mode.

**Rationale**: The timeline has no map surface to tap, so the "tap to place" pattern from the map view doesn't apply. The FAB provides a consistent, discoverable entry point. `AddNodeSheet` already supports search-first via `PlacesAutocomplete` when `initialPlace` is null-ish.

**Alternatives considered**:
- Inline "add between" buttons on each edge connector (clutters the UI)
- Top-bar add button (inconsistent with mobile FAB patterns)
- Long-press on empty timeline space (too discoverable-unfriendly)

## Decision 3: TripMap Mounting Strategy

**Decision**: Keep `TripMap` mounted but hidden (`display: none` via Tailwind's `hidden` class) when timeline is active.

**Rationale**: Google Maps SDK initialization costs 300-500ms per mount. The `fitBounds` flow, tile cache, camera position, and projection state are preserved when hidden. React tree remains in memory but is removed from the paint tree. Memory cost is acceptable for typical trip sizes (20-100 nodes).

**Alternatives considered**:
- Unmount TripMap on view switch: Causes visible loading flash and re-initialization on every toggle. Camera position and zoom lost.
- Conditional rendering with state preservation: Complex — would need to serialize/restore Google Maps camera state.

## Decision 4: Scroll Implementation

**Decision**: Native browser scroll (`overflow-y-auto`) with `-webkit-overflow-scrolling: touch`.

**Rationale**: Typical trip sizes (20-100 nodes) produce at most ~5,000px of content at overview zoom — well within browser paint limits. Native scroll enables CSS `position: sticky` for date gutter labels. Virtualization libraries would break sticky positioning and add unnecessary complexity.

**Alternatives considered**:
- `@tanstack/react-virtual`: 15-30kB bundle addition, breaks `position: sticky`, overkill for typical trip sizes. Revisit if trips regularly exceed 150 nodes.
- Custom scroll handler: Worse performance than native, unnecessary complexity.

## Decision 5: Zoom Implementation

**Decision**: 5 discrete zoom levels controlled by +/- buttons. No pinch-to-zoom.

**Rationale**: Discrete levels provide predictable snap points for the layout algorithm and avoid conflicts with vertical scroll gesture on iOS. UX-designed scale provides good coverage from full-trip overview to hourly detail.

| Level | Name | px/hour | Visible range (~390px) |
|-------|------|---------|----------------------|
| 0 | Overview | 8 | ~35 hours |
| 1 | Day | 16 | ~17 hours |
| 2 (default) | Half-day | 32 | ~9 hours |
| 3 | Detail | 60 | ~5 hours |
| 4 | Hourly | 120 | ~2.5 hours |

**Alternatives considered**:
- Pinch-to-zoom: Conflicts with vertical scroll `touch-action` on iOS. Would require `touch-action: none` which breaks native scrolling.
- Continuous zoom slider: Harder to implement predictable layout; no clear UX advantage over discrete levels.

## Decision 6: Edge Connector Rendering

**Decision**: CSS-only (vertical div with `border-left` styling), not SVG.

**Rationale**: Connectors are simple vertical lines with travel mode differentiation via dash patterns. CSS `border-left` with `border-dashed`/`border-solid`/`border-dotted` covers all modes. Avoids SVG paint overhead and allows connectors to participate naturally in CSS layout flow.

**Alternatives considered**:
- SVG paths: Overkill for straight vertical lines. Would require coordinate calculation separate from CSS layout.
- Canvas: Even more overkill. Not needed for simple static lines.

## Decision 7: Lane Management for Parallel Paths

**Decision**: Up to 3 lanes visible on 390px mobile screen. 4+ lanes trigger horizontal scroll with "more paths" indicator.

**Rationale**: Available lane area = 390px - 56px (date gutter) = 334px. At 3 lanes, each lane is ~111px wide — minimum viable for node name truncation. 4+ lanes at ~83px each would make content unreadable.

**Width distribution**:
| Lanes | Width each | Horizontal scroll |
|-------|-----------|-------------------|
| 1 | 334px | No |
| 2 | 167px | No |
| 3 | ~111px | No |
| 4+ | ~111px | Yes, "+N more" indicator |

## Decision 8: Missing Time Handling

**Decision**: Untimed nodes rendered in a dedicated "Untimed stops" section at the bottom of the timeline with amber warning chips. Nodes with only arrival or only departure get inferred counterparts visually distinguished from explicit times.

**Rationale**: Placing untimed nodes between their DAG neighbors (as originally specified) creates misleading time impressions. A dedicated section makes the incompleteness obvious and encourages users to add times.

**Visual treatment**:
- Untimed: Amber chip "No time set", dashed divider section
- Inferred time: Dashed border style on the inferred side (vs solid for explicit)
- 3+ untimed nodes: Summary warning banner at top of timeline

## Decision 9: Gap Compression

**Decision**: Idle gaps exceeding 8 hours compressed to fixed 40px indicator. Tappable to expand.

**Rationale**: Without compression, overnight stays (8-14 hours) produce huge blank space that wastes scrolling effort. The 40px indicator is consistent across zoom levels — it signals a deliberate break in the proportional time scale.

**Threshold scaling**: The 8-hour threshold is absolute (in real time), not zoom-dependent. This keeps compression behavior predictable across zoom levels.

## Decision 10: State Management

**Decision**: Only 2 new state variables in `page.tsx`: `viewMode` and `timelineZoom`. All existing state (`selectedNodeId`, `selectedEdgeId`, `pathMode`, etc.) is shared.

**Rationale**: The timeline is a view of the same data, not a separate data source. Sharing selection state enables the spec requirement to "preserve selection state when switching between views." Minimal state additions keep the already-large page.tsx manageable.

## Decision 11: Header Layout Adjustment

**Decision**: Three-section flex layout in glass header (`left: back+name | center: planSwitcher+viewToggle | right: bell+avatar`) to accommodate the view toggle pill.

**Rationale**: Current two-group layout doesn't have enough horizontal space for the toggle pill at 390px width. Three-section layout distributes elements more evenly and allows the trip name to use its natural width.
