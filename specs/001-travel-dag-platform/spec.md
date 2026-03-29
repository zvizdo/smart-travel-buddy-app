# Feature Specification: Travel DAG Platform

**Feature Branch**: `001-travel-dag-platform`
**Created**: 2026-03-26
**Status**: Draft
**Input**: User description: "Mobile-first, AI-integrated travel orchestration platform that transforms static text-based itineraries into a dynamic Directed Acyclic Graph (DAG)"

## Clarifications

### Session 2026-03-26

- Q: How should text-to-map import and MCP server share parsing logic? → A: Shared Python library/package imported by both backend and MCP server; frontend calls backend API for import. Avoids inter-service latency and establishes foundation for broader code reuse.
- Q: Does the import flow need separate note extraction and clarification detection subsystems? → A: No. The AI agent handles note extraction, categorization, and clarification conversationally as part of the chat flow. The agent produces structured output (notes with categories and confidence) in its responses and asks clarifying questions naturally. Chat history is persisted to GCS, which provides session continuity. No separate `ImportNote` or `ClarifyingQuestion` models/subsystems are needed — these are just part of the agent's conversational output format.
- Q: Does the MCP server support text import? → A: No. The MCP server does not expose the in-app agent's conversational import flow. External AI agents are expected to construct their own DAG and submit it via the `create_or_modify_trip` tool, which accepts both nodes and edges. This avoids coupling external agents to our internal Gemini agent.
- Q: Can external agents create and modify edges? → A: Yes. The `create_or_modify_trip` MCP tool accepts full DAG structures including nodes and edges. It supports adding, updating, and removing both nodes and edges in a single call, enabling external agents to create complete trips from scratch or make structural changes.
- Q: What are the member edit permissions within a trip? → A: Three roles — Admin (full control, invite, permissions, promote plans, assign participants to nodes), Planner (edit nodes/edges, create alternatives, assign participants to nodes, but cannot change permissions, invite, or promote plans), Viewer (read-only + can add notes, todos, and places to nodes).
- Q: How are trip members notified of changes? → A: In-app notifications only for v1. No email or push notifications.
- Q: How are users invited to a trip? → A: Admin generates role-specific invite links (one per role). When a user clicks the link and registers/signs in via Firebase Auth (Google, Apple, Yahoo), they are automatically added to the trip with the pre-assigned role.
- Q: What can users do while offline? → A: Read-only offline. Users can view the full trip (map, nodes, notes) but cannot make edits. Pulse check-ins are queued for when connectivity returns.
- Q: How does the Magic Import agent work? → A: Three-phase flow: (1) Break text into individual categorized notes, (2) Ask clarifying questions if anything is ambiguous/incomplete/conflicting, (3) Once all notes are clear, assemble them into a DAG. Users can skip clarification to proceed with best-guess defaults. The import is a single ephemeral conversation -- the user must complete it in one session (no persisted import state in Firestore).
- Q: How does the MCP server authenticate? → A: Users generate an API key in their profile settings. The API key grants the AI agent access to all the user's trips. No Firebase Auth tokens are used for MCP -- it's a standalone key-based auth flow.
- Q: What tools does the MCP server expose? → A: `get_trips`, `get_trip_versions`, `get_trip_context`, `create_or_modify_trip` (full CRUD on nodes + edges with auto-cascade), `suggest_stop`, `add_action`, `search_places`, `search_web`. See `contracts/mcp-tools.md` for full definitions. The MCP server must support the full set of trip management capabilities so external AI agents can do everything the in-app agent can.
- Q: What tools does the Gemini agent have? → A: The Gemini agent has Google Maps tool (geocoding, directions, places search) and Google Search tool (for researching destinations, activities, travel info). These are available during both import and ongoing trip management.
- Q: Is the agent only for import or ongoing? → A: The agent persists after trip creation. Users can summon the agent at any time from the trip view to make changes conversationally -- update times, add/remove/reorder nodes, get suggestions, resolve conflicts. All DAG updates and rearrangements can be done manually via the UI OR by talking to the agent. The agent is a first-class interface for the entire trip lifecycle.
- Q: Is the agent chat history persisted? → A: Yes. Chat history is stored in GCS as JSON per user per trip (`{user_id}/{trip_id}/chat-history.json`). A session continues as long as interactions are within 12 hours of each other; after 12h of inactivity the session resets. GCS bucket uses a 7-day auto-delete lifecycle policy. Both import and ongoing agent chats persist to GCS.
- Q: Does the agent learn user preferences across sessions? → A: Yes. The agent extracts travel preferences, rules, and constraints from conversations (e.g., "keep driving under 6h/day", "prefer boutique hotels") and saves them to a Firestore subcollection `trips/{tripId}/preferences`. Preferences are shared across all trip members and injected into the agent's system prompt for every session, including new sessions after a 12h reset.
- Q: How do concurrent users see real-time changes? → A: The frontend uses Firestore `onSnapshot` listeners so that multiple users on the same trip see changes reflected in real-time without manual refresh.
- Q: How do Python services authenticate with Google Cloud? → A: Google Application Default Credentials (ADC) wherever possible. No explicit service account JSON files. Local dev uses `gcloud auth application-default login`.
- Q: What Python environment setup? → A: Single conda environment `travel-app` shared by backend, MCP server, and shared library. No per-project venvs.

### Session 2026-03-27

- Q: How do branches work in the DAG? → A: Branches are implicit, derived at runtime from the DAG topology and participant assignments — not stored as explicit branch IDs. The system works like water flowing downstream: (1) **Linear DAG** (no splits): all participants flow together from first to last node, no assignment needed. (2) **Multiple start nodes**: each participant is assigned to a start node; they flow downstream until paths merge. (3) **Mid-graph split**: participants flow together up to the divergence point, then must be assigned to a post-split node to indicate which path they take. Nodes carry an optional `participant_ids` list (null/empty for linear segments where all participants share the path). The system warns when a participant has no assignment at a divergence point (unresolvable flow). Merge nodes are detected structurally — any node with multiple incoming edges from different paths. Branch colors in the UI are derived from participant group membership at runtime, not from stored branch metadata. This eliminates the need for `branch_id` on edges, `branch_ids` on nodes, and a `branches` map on trips.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Text-to-Map Magic Import (Priority: P1)

A user logs in on their mobile device and creates a new trip. They paste a long, unstructured itinerary (generated from an AI chat or written by hand) into the "Magic Import" tool. The import agent first breaks the text down into individual, categorized notes -- each representing a distinct piece of information (destination, activity, date, budget, preference, accommodation, etc.). If the agent detects ambiguous, incomplete, or conflicting information, it asks the user targeted clarifying questions before proceeding. Once all notes are complete and unambiguous, the agent assembles them into a structured DAG. The frontend sends the text to the backend API, where the AI agent handles note extraction, categorization, and clarification conversationally using shared agent configuration and DAG assembly logic. The shared library (agent config, Pydantic models, DAG assembly) is reused by the MCP server for feature parity — though the MCP server does not expose the conversational import flow itself; external agents submit complete DAGs via `create_or_modify_trip`. The frontend then plots the DAG on an interactive map.

**Why this priority**: This is the foundational user journey. Without the ability to convert text into a visual DAG on a map, no other feature has meaning. It delivers the core "spatial disconnect" solution immediately. The note extraction and clarification steps ensure accuracy before committing to a DAG structure.

**Independent Test**: Can be fully tested by pasting a multi-stop itinerary and verifying that the agent extracts categorized notes, asks clarifying questions for ambiguous input, and ultimately produces a complete DAG with all locations as nodes on a map connected by edges.

**Acceptance Scenarios**:

1. **Given** a logged-in user with no trips, **When** they create a new trip and paste a 1,500-word itinerary into the import tool, **Then** the agent extracts categorized notes from the text and displays them on an interactive map as nodes connected by edges in chronological order.
2. **Given** an imported itinerary with 10+ locations, **When** the import completes, **Then** each node shows the location name, arrival/departure dates (if found), and travel segments show estimated duration or distance.
3. **Given** an itinerary with ambiguous or incomplete location names, **When** the system cannot confidently resolve a location, **Then** the user is prompted to confirm or correct the location from suggested matches.
4. **Given** an imported trip, **When** the user views the map, **Then** they can tap any node to see details and tap any edge to see the travel segment information.
5. **Given** a user provides text containing multiple travel concepts (e.g., "visit Paris in June, wine tour, budget $3000, hiking near the Alps"), **When** the agent processes the text, **Then** it produces separate categorized notes for each distinct concept (destination, timing, activity, budget, etc.).
6. **Given** a user provides vague text like "trip next month", **When** the agent processes it, **Then** it asks clarifying questions about specific dates, destination, and other missing details before proceeding.
7. **Given** the user provides text with conflicting details (e.g., "relaxing beach trip" and "intense hiking every day"), **When** the agent detects the conflict, **Then** it asks the user to clarify their preference or confirm they want both.
8. **Given** the user answers a clarifying question, **When** the response is received, **Then** the agent incorporates the answer into its notes and either asks further questions or proceeds to DAG creation.
9. **Given** the imported text is fully clear and complete, **When** the agent processes it, **Then** no clarifying questions are asked and the agent proceeds directly to DAG creation.
10. **Given** the user wants to skip clarification, **When** they choose to proceed without answering, **Then** the agent uses best-guess defaults and creates the DAG.

---

### User Story 2 - Branching & Group Sync (Priority: P2)

An Admin invites a second group of friends by generating a role-specific invite link (Planner or Viewer). When invitees click the link and sign in via Firebase Auth (Google, Apple, Yahoo), they are automatically added to the trip with the pre-assigned role. The DAG supports divergent paths — either via multiple start nodes (e.g., Group A starts in Denver, Group B starts in Salt Lake City) or via a mid-trip split (e.g., all travel together to a point, then one group heads north and the other heads south). Branches are implicit: the system derives each participant's path by flowing downstream from their assigned start or post-split node. Nodes on divergent paths carry a `participant_ids` list indicating which participants travel through that node; nodes on shared (linear) segments have an empty/null list since all participants pass through. The map displays each participant group's path in a distinct color (derived at runtime from participant membership, not stored branch metadata). Both paths converge at a Merge Node (e.g., Yellowstone), detected structurally as a node with multiple incoming edges from different paths, where the app shows both groups' arrival times and proximity.

**Why this priority**: Group travel coordination is the primary differentiator. Once a trip DAG exists (US1), enabling multiple parties to plan converging routes unlocks the collaborative value.

**Independent Test**: Can be tested by creating a trip, generating invite links, having users join via those links, building a DAG with a divergence point, assigning participants to post-split nodes, and verifying that the map shows distinct colored paths converging at a merge node with arrival-time proximity displayed.

**Acceptance Scenarios**:

1. **Given** an existing trip, **When** the Admin generates a Planner invite link and a user clicks it and signs in, **Then** the user is added to the trip as a Planner with the appropriate permissions.
2. **Given** a DAG with a divergence point (one node with two outgoing edges to different paths), **When** participants are assigned to the post-split nodes, **Then** the system derives each participant's path by flowing downstream and displays each group's route in a distinct color.
3. **Given** a DAG with two paths that converge on the same destination, **When** the system detects a node with multiple incoming edges from different paths, **Then** it identifies it as a Merge Node and displays both groups' estimated arrival times.
4. **Given** a trip with multiple paths, **When** any user views the map, **Then** they can toggle path visibility and filter the view to show all paths or only their own.
5. **Given** a Merge Node, **When** one group's arrival time shifts due to an upstream change, **Then** the app recalculates and shows the updated time gap between groups.
6. **Given** a DAG with a divergence point, **When** a participant has not been assigned to any post-split node, **Then** the system displays a warning indicating the participant's path is unresolved and prompts the Admin or Planner to assign them.
7. **Given** a linear DAG with no divergence points, **When** new participants join, **Then** no participant assignment is needed — all participants flow through the entire path automatically.
8. **Given** a DAG with multiple start nodes (e.g., Group A from Denver, Group B from Salt Lake City), **When** participants are assigned to their respective start nodes, **Then** each group's path is displayed in a distinct color from their start node through to the merge point and beyond.

---

### User Story 3 - Cascading Schedule Updates (Priority: P2)

A Planner or Admin modifies a single node in the trip DAG (e.g., extends a stay by one day). The cascading engine automatically propagates the change downstream, shifting all subsequent hotel stays, flights, and activities forward in time. The user sees a preview of all affected nodes before confirming.

**Why this priority**: Tied with US2 because cascading logic is what makes the DAG more than a static map. Changing one node and seeing the downstream impact is the "aha moment" that justifies the DAG model over a list.

**Independent Test**: Can be tested by modifying a mid-trip node's dates and verifying that all downstream nodes shift accordingly, with a preview shown before confirmation.

**Acceptance Scenarios**:

1. **Given** a trip with 8 sequential nodes, **When** a Planner extends the stay at node 3 by one day, **Then** nodes 4-8 shift forward by one day and the changes are previewed before confirmation.
2. **Given** a cascading update preview, **When** the user reviews affected nodes, **Then** each affected node highlights what changed (dates, overlap warnings) and the user can confirm or cancel.
3. **Given** a trip with divergent paths, **When** a change cascades past a divergence point, **Then** only the downstream nodes on the affected path are updated (not the other path).
4. **Given** a cascading update that causes a conflict (e.g., hotel checkout overlaps with a flight), **When** the conflict is detected, **Then** the system warns the user and suggests resolution options.
5. **Given** a Viewer role user, **When** they attempt to modify a node's dates, **Then** the system denies the action and indicates insufficient permissions.

---

### User Story 4 - Alternative Plan Versioning (Priority: P3)

A Planner or Admin creates an "Alternative Plan" to explore a schedule variation (e.g., adding an extra day at the Grand Canyon) without disrupting the main plan. After the group reviews both versions, only the Admin can promote the alternative to become the new "Main" plan, instantly updating everyone's view. An in-app notification informs all trip members of the promotion.

**Why this priority**: Versioning builds on top of the DAG and cascading engine (US1 + US3). It's a power-user feature for group decision-making that adds polish but isn't required for core trip management.

**Independent Test**: Can be tested by creating an alternative plan from an existing trip, making changes, then promoting it to main and verifying all group members see the updated plan.

**Acceptance Scenarios**:

1. **Given** an existing main plan, **When** a Planner creates an Alternative Plan, **Then** a copy of the current DAG is created as a named version and the Planner can edit it independently.
2. **Given** two plan versions (Main and Alternative), **When** the user switches between them, **Then** the map updates to reflect the selected version's nodes and edges.
3. **Given** an Alternative Plan, **When** the Admin promotes it to Main, **Then** all trip members see the promoted plan as the active itinerary and the previous main is archived.
4. **Given** a Planner role user, **When** they attempt to promote an Alternative Plan, **Then** the system denies the action and indicates only the Admin can promote plans.
5. **Given** multiple group members, **When** a promotion occurs, **Then** all members receive an in-app notification that the active plan has changed.

---

### User Story 5 - Offline Access & Pulse Check-in (Priority: P3)

While traveling through areas with poor connectivity, the user can still view their full trip map, all notes, and location details thanks to offline-first storage. Offline mode is read-only — no edits are permitted until connectivity returns. When connectivity is available, the user can trigger a manual "Pulse" check-in that updates their avatar position on the map, letting other group members see their real-time location.

**Why this priority**: Offline access and location sharing are essential for the on-the-road experience but depend on having a fully functional trip (US1-US3) to be meaningful.

**Independent Test**: Can be tested by loading a trip while online, going offline, verifying all map data and notes remain viewable (but not editable), then going online and triggering a Pulse check-in visible to other group members.

**Acceptance Scenarios**:

1. **Given** a user who previously loaded a trip while online, **When** the device loses connectivity, **Then** the full trip map, node details, and all notes remain viewable.
2. **Given** an offline user, **When** they attempt to edit a node or add a note, **Then** the system indicates the action requires connectivity.
3. **Given** connectivity is restored, **When** the user triggers a Pulse check-in, **Then** their avatar moves to their current GPS coordinates on the shared map.
4. **Given** a group trip, **When** one member checks in, **Then** all other online members see the updated avatar position within 30 seconds.

---

### User Story 6 - In-App Agent for Ongoing Trip Management (Priority: P2)

After a trip is created (via Magic Import or manually), the AI agent remains available within the trip view. Users can summon the agent at any time to make changes conversationally rather than through manual UI interactions. The agent can update times, add/remove/reorder nodes, search for places, research destinations, and resolve scheduling conflicts -- all via natural language. The agent has access to Google Maps (geocoding, directions, places search) and Google Search (destination research, activity info) as tools.

**Why this priority**: Elevated to P2 because the agent is a first-class interface for the entire trip lifecycle, not just import. Conversational trip management is a core differentiator -- users can say "push our Paris stay back one day" instead of manually editing dates and confirming cascading updates.

**Independent Test**: Can be tested by opening an existing trip, summoning the agent, asking it to add a stop between two nodes, and verifying the DAG updates correctly with the new node and recalculated edges.

**Acceptance Scenarios**:

1. **Given** an existing trip, **When** a user opens the agent chat and says "add a 2-night hotel stop in Lyon between Paris and the Alps", **Then** the agent uses Google Maps to geocode Lyon, inserts a new node, creates edges, and cascades timing changes downstream.
2. **Given** an existing trip, **When** a user says "push our Paris stay back one day", **Then** the agent modifies the Paris node's dates and cascading updates propagate to all downstream nodes.
3. **Given** an existing trip, **When** a user says "find a good Italian restaurant near our hotel in Paris", **Then** the agent uses Google Maps Places API to search and presents options the user can pin to the node.
4. **Given** an existing trip, **When** a user says "what's the weather like in the Alps in June?", **Then** the agent uses Google Search to research and responds with relevant information.
5. **Given** an existing trip, **When** a user says "remove the Grand Canyon stop and reconnect the route", **Then** the agent removes the node, reconnects edges, and cascades timing changes.
6. **Given** the agent makes changes, **When** other users are viewing the same trip, **Then** changes appear in real-time via Firestore onSnapshot listeners.

---

### User Story 7 - External AI Assistant via MCP Server (Priority: P3)

A user connects their external AI assistant (e.g., Claude Desktop, phone assistant) to the app via the MCP Server using their API key. The external agent can do everything the in-app agent can -- query trip data, modify the DAG, search for places, and manage the trip. The MCP server exposes the full set of trip management capabilities to ensure feature parity with the in-app agent.

**Why this priority**: The MCP integration layers on top of a complete trip and the agent infrastructure from US6. It's high-value for power users who prefer their own AI tools.

**Independent Test**: Can be tested by configuring an MCP client with an API key, querying trip data, modifying nodes, and verifying changes appear in the app in real-time.

**Acceptance Scenarios**:

1. **Given** a trip with notes and pinned locations, **When** a user queries their external AI assistant about trip details, **Then** the MCP server retrieves the relevant data and the assistant responds accurately.
2. **Given** a trip with time-sensitive data (e.g., "tomorrow's dinner"), **When** the query references relative time, **Then** the response correctly resolves "tomorrow" based on the current date and the trip schedule.
3. **Given** a multi-member trip, **When** a user asks "What did [member name] add?", **Then** the response filters notes and pins by the specified member.
4. **Given** an external AI agent, **When** it calls `create_or_modify_trip` to add a new node with edges, **Then** the change appears in the app in real-time for all trip participants via onSnapshot.
5. **Given** an external AI agent, **When** it performs any DAG operation available to the in-app agent (add/remove/update nodes and edges, cascade updates, search places), **Then** the result is identical to performing the same action via the in-app agent.
6. **Given** an external AI agent with no existing trip DAG, **When** it calls `create_or_modify_trip` with a complete set of nodes and edges, **Then** the system creates a full trip plan with all nodes connected by the specified edges, identical in structure to a DAG built via Magic Import.
7. **Given** an external AI agent, **When** it calls `create_or_modify_trip` with edges_to_add, edges_to_update, or edges_to_remove, **Then** the edge modifications are applied and cascading updates propagate to affected downstream nodes.

---

### Edge Cases

- What happens when the user provides an empty or whitespace-only text input?
  - The system informs the user that no content was provided and prompts them to paste or type their itinerary.
- What happens when the imported text contains no identifiable locations or actionable travel information?
  - The system informs the user that no locations were found and suggests formatting tips.
- What happens when the user provides text with repeated or overlapping information?
  - The agent deduplicates and merges related concepts into coherent notes before building the DAG.
- What happens if the user ignores or dismisses clarifying questions without answering?
  - The agent proceeds with best-guess defaults and creates the DAG, noting which assumptions were made.
- How does the system handle extremely long text inputs (e.g., 10,000+ characters)?
  - Input text is capped at a reasonable limit; the system informs the user if the text exceeds the maximum and suggests splitting it.
- How does the system handle text with special characters, URLs, or copy-pasted formatted content?
  - The agent strips formatting and processes the underlying text content.
- How does the system handle circular routes (A -> B -> C -> A)?
  - The DAG treats the return to A as a new node instance (A') to preserve the acyclic property while displaying it as a return trip visually.
- What happens when two Planners edit the same node simultaneously?
  - Last-write-wins with conflict detection: the second user is notified of the conflicting change via an in-app notification and can merge or overwrite.
- What if a Pulse check-in fails due to GPS unavailability?
  - The user is notified that location could not be determined and offered the option to manually pin their location.
- What happens when promoting an alternative plan while other Planners are actively editing the main plan?
  - Active editors are warned via in-app notification before promotion. Unsaved changes are preserved as a draft version.
- What happens when a user clicks an expired or already-used invite link?
  - The system displays a clear error message and suggests contacting the trip Admin for a new link.
- What happens when a Viewer attempts a Planner-level action?
  - The system denies the action with a message indicating their current role and the required permission level.
- What happens when a new divergence point is created (e.g., a node splits into two outgoing edges) and existing participants have no assignment?
  - The system detects unresolved participant flows and displays a warning to the Admin/Planner. The warning lists which participants need to be assigned to a post-split node. The DAG is still valid but the unassigned participants' paths are shown as "unresolved" in the UI.
- What happens when a participant is assigned to a node that is not reachable from their current position in the DAG?
  - The system validates that the assigned node is downstream from the participant's last assigned or start node. If not reachable, the assignment is rejected with an error message.
- What happens when all divergent paths are removed and the DAG becomes linear again?
  - The `participant_ids` on previously divergent nodes become irrelevant. The system treats all participants as flowing through the single path. Stale `participant_ids` are cleaned up automatically.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow users to create, name, and manage trips.
- **FR-002**: System MUST parse unstructured text itineraries by breaking the text into individual, categorized notes (destination, date/timing, activity, budget, preference, accommodation) before assembling them into a DAG structure. Note extraction, categorization, and clarification are handled conversationally by the AI agent as part of the chat flow — the agent produces structured output (notes with categories and confidence) in its responses. No separate extraction or clarification subsystems are required.
- **FR-002a**: System MUST detect when imported text contains ambiguous, incomplete, or conflicting information and generate targeted clarifying questions for the user. This includes geocoding-specific ambiguity — when a location name cannot be confidently resolved, the user MUST be prompted with suggested matches to confirm or correct.
- **FR-002b**: System MUST present clarifying questions one at a time or in a focused batch to avoid overwhelming the user.
- **FR-002c**: System MUST incorporate user responses to clarifying questions into the existing notes before proceeding to DAG creation.
- **FR-002d**: System MUST allow users to skip clarifying questions and proceed with best-guess defaults.
- **FR-002e**: System MUST handle empty or non-actionable input gracefully by informing the user that no travel information was found.
- **FR-002f**: System MUST preserve all original user-provided information throughout the clarification and DAG creation process.
- **FR-003**: System MUST display trip DAGs on an interactive map with nodes (stops) and edges (travel segments).
- **FR-004**: System MUST support user authentication via Firebase Auth (Google, Apple, Yahoo sign-in) and role-based trip access control with three roles: Admin (full control), Planner (edit DAG, create alternatives), Viewer (read-only + notes/todos/places).
- **FR-005**: System MUST support divergent paths within a single trip DAG. Paths are implicit — derived at runtime from DAG topology (edges) and participant assignments (optional `participant_ids` on nodes). For linear DAGs (no splits), no participant assignment is needed. For DAGs with divergence points or multiple start nodes, participants MUST be assigned to post-split or start nodes to determine their path. The system MUST warn when a participant's path is unresolvable (no assignment at a divergence point). Planners can edit nodes on any path.
- **FR-006**: System MUST identify Merge Nodes structurally — any node with multiple incoming edges from different paths — and display each participant group's estimated arrival time at the merge point.
- **FR-007**: System MUST propagate schedule changes downstream through the DAG (cascading updates) and preview affected nodes before confirmation.
- **FR-008**: System MUST support creating and viewing Alternative Plan versions. Planners can create alternatives; only Admins can promote an alternative to Main.
- **FR-009**: System MUST cache trip data locally for read-only offline access. Editing MUST require connectivity. Pulse check-ins MUST be queued when offline and sent on reconnection.
- **FR-010**: System MUST support manual Pulse check-ins that broadcast user location to trip members.
- **FR-011**: System MUST expose trip data via an MCP Server with tools: `get_trips` (list user's trips), `get_trip_versions` (list plan versions), `get_trip_context` (full DAG, defaults to main version, accepts optional version ID), `create_or_modify_trip` (create a full DAG or modify existing nodes and edges with auto-cascade), `suggest_stop` (Places API search along a route), `add_action` (attach note/todo/place to a node), `search_places` (Google Places API near a location), and `search_web` (web search for travel information). See `contracts/mcp-tools.md` for full tool definitions.
- **FR-011a**: MCP Server MUST authenticate via user-generated API keys. Users MUST be able to generate and revoke API keys from their profile settings. An API key grants the AI agent access to all trips the user participates in.
- **FR-011b**: System MUST use Firestore `onSnapshot` real-time listeners on the frontend so that multiple users on the same trip see changes reflected immediately without manual refresh.
- **FR-012**: System MUST allow users to attach notes, restaurant pins, and personal annotations to any node. Viewers MUST be able to add notes, todos, and places.
- **FR-013**: System MUST deliver in-app notifications for significant changes (plan promotions, upstream schedule shifts affecting a participant's path, concurrent edit conflicts, unresolved participant assignments at divergence points).
- **FR-014**: *(Merged into FR-002a — geocoding-specific ambiguity is covered there.)*
- **FR-015**: System MUST allow Admins to generate role-specific invite links. When a user clicks an invite link and authenticates via Firebase Auth, they MUST be automatically added to the trip with the pre-assigned role.
- **FR-016**: System MUST provide an in-app AI agent accessible from any trip view. The agent MUST be able to perform all trip management actions conversationally: add/remove/update/reorder nodes, cascade schedule changes, search for places, and research destinations.
- **FR-016a**: The Gemini agent MUST have Google Maps tool access (geocoding, directions, places search) and Google Search tool access (destination research, travel information) during both import and ongoing trip management.
- **FR-016b**: The in-app agent MUST persist after trip creation. Users MUST be able to summon the agent at any time from the trip view to make changes via conversation.
- **FR-016c**: The MCP Server MUST expose the full set of trip management capabilities available to the in-app agent, ensuring feature parity so external AI agents can perform identical operations. External agents create trips by submitting a complete DAG (nodes + edges) via `create_or_modify_trip` rather than using the in-app conversational import flow.
- **FR-017**: System MUST persist agent chat history in Google Cloud Storage as JSON, keyed by `{user_id}/{trip_id}/chat-history.json`. A conversation session MUST continue if the last interaction was within 12 hours; otherwise a new session MUST start. The GCS bucket MUST use a 7-day auto-delete lifecycle policy. Both import and ongoing agent conversations MUST be persisted.
- **FR-018**: The agent MUST automatically extract travel preferences, rules, and constraints from conversations and persist them to a Firestore subcollection `trips/{tripId}/preferences`. Preferences are shared across all trip members and MUST be injected into the agent's system prompt for every session (including new sessions after 12h reset).

### Key Entities

- **Trip**: A named travel plan owned by an Admin, containing one or more plan versions and members with assigned roles.
- **Member**: A user associated with a trip in one of three roles: Admin, Planner, or Viewer. Role determines permitted actions.
- **Node**: A stop or destination within a trip (location, dates, notes, attachments). Represents a vertex in the DAG. Optionally carries a `participant_ids` list — null/empty on shared (linear) segments where all participants pass through; populated on divergent segments to indicate which participants travel through this node.
- **Edge**: A travel segment connecting two nodes (mode of transport, estimated duration/distance). Represents a directed connection in the DAG. No branch/path identifier — paths are inferred from DAG topology and participant assignments.
- **Merge Node**: A node with multiple incoming edges from different paths, detected structurally at runtime. Displays arrival-time proximity for each converging participant group. Not a separate entity — identified by graph analysis.
- **Plan Version**: A named snapshot of the entire trip DAG (Main or Alternative), supporting side-by-side comparison and promotion.
- **Pulse**: A point-in-time location broadcast by a user, displayed as an avatar on the shared map.
- **Note**: A user-authored annotation (text, pin, recommendation) attached to a specific node. Creatable by all roles.
- **Invite Link**: A role-specific URL generated by the Admin that, when clicked, authenticates the user and adds them to the trip with the pre-assigned role.
- **API Key**: A user-generated credential for MCP server authentication, stored hashed. Grants AI agents access to all the user's trips.
- **Preference**: An agent-extracted travel rule, constraint, or preference attached to a trip (e.g., "max 6h driving per day", "prefer boutique hotels"). Shared across all trip members and injected into every agent session.

## Success Criteria *(mandatory)*

### Buildable Criteria (verifiable during development)

- **SC-001**: Users can import a 1,500-word unstructured itinerary and see a complete trip map within 60 seconds.
- **SC-002**: When a user modifies a node's schedule, all downstream nodes update within 5 seconds and the preview is displayed before confirmation.
- **SC-003**: Group members on separate paths can see each other's routes and merge points on a single shared map.
- **SC-004**: Users can view their full trip (map, nodes, notes) without any network connectivity after having loaded it once while online.
- **SC-005**: Pulse check-ins are visible to other online group members within 30 seconds of being triggered.
- **SC-006**: AI assistant queries about trip data return accurate, contextually relevant responses based on live trip information.
- **SC-007**: Alternative plan promotion updates every group member's active view within 10 seconds.
- **SC-009**: Users clicking an invite link are added to the trip with the correct role within one sign-in step.

### Launch Metrics (measured post-launch, not buildable tasks)

- **SC-008**: 90% of users can successfully import their first trip without needing to consult help documentation.
- **SC-010**: 90% of extracted import notes are relevant and correctly categorized on first attempt.
- **SC-011**: Users need to answer no more than 5 clarifying questions on average before a DAG is generated.
- **SC-012**: 80% of users successfully complete the full import-to-map flow without abandoning the process.

## Assumptions

- Users authenticate via Firebase Auth supporting Google, Apple, and Yahoo sign-in providers.
- The AI-powered text import uses a large language model (e.g., Gemini) for natural language parsing; the exact model is configurable.
- The shared Python library/package provides agent configuration (prompts, tool declarations, response schemas) and DAG assembly logic, imported by both the backend and the MCP server to avoid code duplication and enable broad reuse.
- Note extraction, categorization, and clarification during import are handled conversationally by the AI agent — no separate extraction or clarification subsystems are needed. The agent's structured response format (notes with categories/confidence, ready_to_build flag) is the interface.
- The mapping interface uses a third-party map provider (e.g., Google Maps) for rendering and geocoding.
- Mobile-first means the primary interface is optimized for mobile browsers or a progressive web app; a native mobile app is out of scope for v1.
- Real-time data persistence uses a cloud-hosted document database (e.g., Firestore) with offline read caching.
- The MCP Server is deployed as a separate service that imports the shared library and connects to the same data store.
- Group sizes are expected to be small (2-20 members per trip) for v1.
- Trip DAGs are expected to have up to 50 nodes and 100 edges for v1; larger trips are a future consideration.
- Branches/paths are implicit — derived at runtime from DAG topology and `participant_ids` on nodes. No explicit branch entity or branch ID is stored. Path colors in the UI are computed from participant group membership.
- Notifications are in-app only for v1; push and email notifications are deferred to a future version.
- The magic import is an ephemeral conversation with respect to Firestore -- no import state is persisted to Firestore. However, the chat history is persisted to GCS for agent context continuity. The frontend still sends the full messages array on each import request.
- Import text input is capped at a reasonable limit (e.g., 10,000 characters) to ensure processing performance.
- Users will primarily input English text for import (multi-language support is out of scope for v1).
