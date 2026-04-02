# Feature Specification: DAG Timeline View

**Feature Branch**: `002-dag-timeline-view`  
**Created**: 2026-04-01  
**Status**: Draft  
**Input**: User description: "Build a vertical timeline view that shows the same DAG as the map view, organized by time rather than geography, with full interaction parity."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - View Trip Schedule as Timeline (Priority: P1)

A trip planner wants to see their trip's itinerary organized chronologically rather than geographically. They tap the Timeline segment in the header pill to switch from the map view to the timeline view and see all their stops laid out vertically from top to bottom, with earlier stops at the top. Each stop is shown as a block whose height reflects how long they'll be there (similar to Google Calendar events). Dates are shown on the left, and travel segments between stops are clearly visible between blocks.

**Why this priority**: This is the core value proposition — without the timeline rendering, nothing else matters. The map view shows where you're going; the timeline view shows when you're going. Most trip planning decisions are time-constrained ("Can we fit a restaurant visit before our flight?"), and the timeline makes those constraints visible at a glance.

**Independent Test**: Can be fully tested by creating a trip with 5+ nodes that have arrival and departure times set, switching to timeline view, and verifying that all nodes appear in chronological order with proportional height sizing. Delivers immediate value as a read-only schedule overview.

**Acceptance Scenarios**:

1. **Given** a trip with nodes that have arrival and departure times, **When** the user taps the "Timeline" segment in the header pill, **Then** all nodes are displayed vertically from earliest to latest, with each node block's height proportional to its duration.
2. **Given** a trip with a node lasting 6 hours and another lasting 1 hour, **When** viewing the timeline, **Then** the 6-hour block is visibly taller than the 1-hour block, reflecting the duration difference.
3. **Given** a trip spanning multiple days, **When** viewing the timeline, **Then** date labels appear in the left gutter aligned with the corresponding time positions, and day boundaries are clearly marked.
4. **Given** nodes with travel edges between them, **When** viewing the timeline, **Then** travel segments are displayed as connectors between node blocks, showing the travel mode (drive, flight, transit, walk) and duration.

---

### User Story 2 - Interact with Nodes and Edges on Timeline (Priority: P2)

A trip planner wants to manage their itinerary directly from the timeline view without switching back to the map. They tap a node block to see its details, edit times, add notes, or delete it. They tap an edge connector to see travel info and insert a new stop between two existing ones. They can branch from a node's detail sheet to create an alternative path.

**Why this priority**: Full interaction parity with the map view is what makes the timeline a true alternative view rather than just a visualization. Without it, users are forced to context-switch between views to make changes, undermining the timeline's usefulness.

**Independent Test**: Can be tested by opening the timeline, tapping a node block to confirm the detail sheet opens, editing arrival/departure times, then tapping an edge connector and using "insert stop" to add a new node between two existing ones.

**Acceptance Scenarios**:

1. **Given** the timeline view is active, **When** the user taps a node block, **Then** the same node detail sheet opens as in the map view, showing all node information and edit/branch/delete actions.
2. **Given** the timeline view is active, **When** the user taps an edge connector between two nodes, **Then** the edge detail sheet opens showing travel mode, duration, and distance, with an "insert stop" action available.
3. **Given** the user taps "insert stop" on an edge in the timeline, **When** they complete the add-node form, **Then** a new node is inserted between the two existing nodes, the old edge is split into two, and the timeline updates to show the new node in its correct chronological position.
4. **Given** the user opens a node's detail sheet from the timeline and taps "Branch", **When** they complete the branch form, **Then** a new branch path is created and the timeline shows the diverging lanes.

---

### User Story 3 - View Branching Paths as Parallel Lanes (Priority: P3)

A group trip has participants taking different paths (e.g., Alice visits a museum while Bob goes to a restaurant). The timeline shows these diverging paths as separate parallel lanes, making it clear who is doing what and when. When paths merge back together, the lanes converge into a single column. If the trip has multiple starting points, each root appears as its own lane from the top.

**Why this priority**: Multi-participant branching is the distinguishing feature of this app's DAG model. Representing it clearly in the timeline is essential for group trip coordination, but it builds on top of the basic single-lane timeline and node interaction.

**Independent Test**: Can be tested by creating a trip with a divergence point (one node branching into two paths for different participants), switching to the timeline, and verifying that two lanes appear with the correct nodes in each, merging back when paths rejoin.

**Acceptance Scenarios**:

1. **Given** a trip where paths diverge from a node (e.g., two outgoing edges to different branches), **When** viewing the timeline, **Then** the diverging paths are shown as separate parallel lanes, each containing the nodes for that branch.
2. **Given** diverging paths that later reconverge at a merge node, **When** viewing the timeline, **Then** the separate lanes merge back into a single lane at the merge point.
3. **Given** a trip with multiple root nodes (different starting points for different participants), **When** viewing the timeline, **Then** each root node appears at the top in its own lane at its respective time position.
4. **Given** the timeline shows parallel lanes, **When** the user filters to "my path" mode, **Then** only the user's assigned lane is displayed.

---

### User Story 4 - Handle Missing and Partial Times (Priority: P4)

A planner has added stops to their trip but hasn't set exact times for all of them. The timeline still displays these nodes in a reasonable position — between their neighbors — with a clear visual warning that times need to be set. Nodes with only arrival or only departure times use sensible defaults for the missing value.

**Why this priority**: Real-world trip planning is iterative. Users often add stops before they know exact times. The timeline must gracefully handle incomplete data to remain useful throughout the planning process, not just after all details are finalized.

**Independent Test**: Can be tested by creating a trip with three nodes where the middle node has no arrival or departure time, switching to the timeline, and verifying the node appears between its neighbors with a visible "times not set" warning.

**Acceptance Scenarios**:

1. **Given** a node with neither arrival nor departure time set, **When** viewing the timeline, **Then** the node is positioned between its neighboring nodes (based on DAG edges) and displays a warning indicator that times have not been set.
2. **Given** a node with only an arrival time set, **When** viewing the timeline, **Then** the node is shown at the arrival time with an inferred departure time of arrival + 1 hour, and the inferred time is visually distinguished from explicitly set times.
3. **Given** a node with only a departure time set, **When** viewing the timeline, **Then** the node is shown with an inferred arrival time of departure - 1 hour, and the inferred time is visually distinguished.
4. **Given** multiple nodes with missing times, **When** viewing the timeline, **Then** a summary warning is shown indicating how many stops need times set.

---

### User Story 5 - Navigate and Zoom the Timeline (Priority: P5)

A planner with a 10-day trip wants to quickly scan the full itinerary overview, then zoom into a specific day to see hourly detail. They can scroll vertically through the timeline and adjust the zoom level to see more or fewer days at once. Long idle gaps (e.g., overnight stays) are visually compressed so they don't waste screen space.

**Why this priority**: Without zoom and gap compression, the timeline becomes unusable for longer trips — either too zoomed in (endless scrolling) or too zoomed out (unreadable). This is an ergonomic necessity but builds on the foundational rendering.

**Independent Test**: Can be tested by creating a 5-day trip, opening the timeline, zooming out to see all days, then zooming in to see hourly detail on a specific day, and verifying that gap compression activates for overnight periods.

**Acceptance Scenarios**:

1. **Given** a multi-day trip in the timeline view, **When** the user adjusts the zoom level, **Then** the timeline rescales so that more or fewer hours are visible on screen, with node blocks resizing proportionally.
2. **Given** consecutive nodes with a gap exceeding 8 hours (e.g., overnight at a hotel), **When** viewing the timeline, **Then** the idle gap is visually compressed to a fixed-size indicator showing the gap duration, rather than occupying proportional vertical space.
3. **Given** the user is scrolled to a specific position in the timeline and switches to the map view and back, **When** returning to the timeline, **Then** the scroll position is preserved.

---

### Edge Cases

- What happens when a trip has no nodes yet? The timeline shows an empty state with a prompt to add stops or switch to the map view.
- What happens when all nodes lack timestamps? Nodes are displayed in DAG topological order with equal spacing and each node shows a timing warning.
- What happens when a node's departure time is before its arrival time? The node is displayed with a red conflict indicator on the timeline block, and the detail sheet surfaces the error for correction.
- What happens when two consecutive nodes on the same lane have overlapping time windows? Both blocks are rendered with a visual conflict marker (red border/highlight) indicating the overlap.
- What happens when a user selects a node on the map and switches to the timeline? The timeline opens scrolled to and highlighting the selected node, preserving selection state across view switches.
- What happens when a single lane has 30+ nodes? The timeline scrolls vertically; no virtualization is needed for typical trip sizes but the rendering should remain smooth.
- What happens when 4+ parallel lanes exist on a mobile screen? The first 3 lanes are shown with a "more paths" indicator; horizontal scrolling reveals additional lanes.
- What happens when the user is offline? The timeline view respects the same offline restrictions as the map — editing is disabled and the offline banner is shown.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a timeline view as an alternative to the map view, accessible via a compact two-segment pill (Map | Timeline) in the top glass header of the trip page. The active segment is highlighted; tapping the inactive segment switches views.
- **FR-002**: System MUST render nodes as vertically-arranged blocks where the vertical position corresponds to the node's arrival time and the block height corresponds to the duration (departure minus arrival).
- **FR-003**: System MUST display a date gutter on the left side of the timeline showing date labels aligned with the corresponding time positions, with clear day boundary markers.
- **FR-004**: System MUST render edges between nodes as visual connectors, differentiated by travel mode (drive, flight, transit, walk), showing travel duration.
- **FR-005**: System MUST support all node interactions available in the map view: viewing details, editing, deleting, and branching — all through the same existing detail sheets. Adding new nodes in the timeline is initiated via a floating "+" action button positioned at the bottom-right of the timeline, which opens the add-node form in search-first mode (place search instead of map tap).
- **FR-006**: System MUST support edge interactions: viewing edge details and inserting a stop between two nodes (edge splitting) via the same existing edge detail sheet.
- **FR-007**: System MUST display diverging participant paths as separate parallel lanes and merge them back into a single lane when paths reconverge.
- **FR-008**: System MUST display multiple root nodes (multiple trip starting points) as parallel lanes beginning at their respective time positions.
- **FR-009**: System MUST handle nodes with missing times: no times set positions the node between its DAG neighbors with a visible warning; arrival-only infers departure as arrival + 1 hour; departure-only infers arrival as departure - 1 hour.
- **FR-010**: System MUST visually distinguish inferred/missing times from explicitly set times using distinct border and background treatments plus a warning indicator.
- **FR-011**: System MUST support multiple zoom levels allowing users to view the timeline at different time scales, from full-trip overview to hourly detail.
- **FR-012**: System MUST compress long idle gaps (exceeding 8 hours with no nodes or active edges) into a fixed-size visual indicator showing the gap duration, to prevent excessive scrolling.
- **FR-013**: System MUST preserve node and edge selection state when switching between map and timeline views.
- **FR-014**: System MUST support participant path filtering ("all paths" vs "my path") using the existing path filter, rendering either multiple lanes or a single lane accordingly.
- **FR-015**: System MUST display timing conflicts (departure before arrival, overlapping consecutive nodes) with a visible error indicator on the affected blocks.
- **FR-016**: System MUST respect the same permission model as the map view — only admins and planners can edit; planners viewing the active plan see read-only mode; offline disables editing.
- **FR-017**: System MUST show node type differentiation (city, hotel, restaurant, place, activity) through distinct visual treatments on the timeline blocks, consistent with existing type styling.
- **FR-018**: System MUST handle timezone differences between consecutive nodes by displaying timezone transition indicators between nodes in different timezones.

### Key Entities

- **Timeline Layout**: A computed representation mapping each node to a vertical position (Y-coordinate) and lane assignment, and each edge to a connector path between node blocks. Derived entirely from existing Node and Edge data — no new persisted data.
- **Lane**: A vertical column representing a single participant path through the DAG. Lanes appear when paths diverge and collapse when paths merge. Lane count is determined by the maximum number of simultaneously active parallel paths.
- **Gap Compression**: A visual indicator replacing long idle periods in the timeline, showing the compressed duration. Not a data entity — purely a rendering optimization.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can switch between map and timeline views in under 0.5 seconds, with no loss of selection state or data.
- **SC-002**: Users can identify the chronological order and duration of all trip stops within 5 seconds of opening the timeline view.
- **SC-003**: Users can perform any node or edge modification (edit, delete, branch, insert stop) from the timeline view using the same number of taps as the map view.
- **SC-004**: 90% of users with trips containing missing node times can identify which stops need times set, thanks to visible warning indicators.
- **SC-005**: A trip with 50+ nodes renders the timeline without perceptible lag or jank during scrolling and zooming.
- **SC-006**: Users viewing a branching group trip can identify which participants are on which path within 3 seconds by reading the lane layout.
- **SC-007**: The timeline view is usable on mobile screens (390px width) with all interactive elements meeting minimum 44px touch target sizes.

## Clarifications

### Session 2026-04-01

- Q: Where should the Map/Timeline view toggle be placed? → A: Compact two-segment pill (Map | Timeline) in the top glass header, following the established travel app pattern (Airbnb, Google Maps, Apple Maps). Bottom nav remains unchanged.
- Q: Should bottom nav alignment when PulseButton is hidden be addressed in this feature? → A: Out of scope. The bottom nav is unchanged by this feature; the pulse alignment inconsistency is pre-existing and unrelated.
- Q: How do users add new nodes from the timeline (no map surface to tap)? → A: Floating "+" action button (FAB) at the bottom-right of the timeline, opens AddNodeSheet in search-first mode.

## Assumptions

- The existing Node and Edge data models contain all information needed for the timeline — no backend changes or new data fields are required.
- The existing bottom sheet components (NodeDetailSheet, AddNodeSheet, EdgeDetail, DivergenceResolver) can be reused without modification since they are view-agnostic overlays.
- The existing path computation algorithm provides the lane assignment data needed to determine which nodes belong to which participant path.
- The "insert stop" flow in the timeline uses a search-first approach (place search) rather than a map-tap approach, since there is no map surface to tap.
- Timezone display defaults to each node's local timezone; a global timezone toggle is not included in the initial scope.
- Desktop split-screen mode (map + timeline side by side) is out of scope for the initial release.
- Bottom nav alignment when PulseButton is hidden is a pre-existing layout inconsistency and is out of scope for this feature.
- The timeline does not introduce any new API endpoints — all data comes from existing Firestore real-time subscriptions.
- Node ordering within the timeline follows the time axis; when times are equal, DAG topological order (order_index) is used as a tiebreaker.
