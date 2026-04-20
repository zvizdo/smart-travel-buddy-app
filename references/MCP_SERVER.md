# MCP Server Reference

fastmcp 3.2 server for external AI agents via Model Context Protocol. Transport: `streamable-http` only (Cloud Run).

## Entry Point (`mcpserver/src/main.py`)

Mirrors `backend/src/main.py` shape — `load_dotenv(mcpserver/.env)` at the top, then module-level eager init (`firebase_admin.initialize_app()`, `AsyncClient()`, `ApiKeyTokenVerifier`, `FastMCP(..., auth=_token_verifier)`), tool modules imported for registration side-effects, and finally `app = mcp.http_app(path="/mcp")` exposed at module scope. Run as `uvicorn mcpserver.src.main:app --host 0.0.0.0 --port ${PORT}` (Dockerfile CMD) or `cd mcpserver && uvicorn src.main:app --reload --port 8080` locally. Dotted-path loading means `main.py` is always imported under its real module name, so the `mcp` instance tool modules import is the same one uvicorn serves — no `__main__.py` shim, no double-import risk. Per-request services (`TripService`, `DAGService`, `PlanService`, `PlacesService`, `httpx.AsyncClient`) are built in the FastMCP `app_lifespan` and reach tools via `AppContext` (`ctx.lifespan_context`).

## Auth Architecture

`ApiKeyTokenVerifier` extends fastmcp's `TokenVerifier` base class (`from fastmcp.server.auth import TokenVerifier`). `TokenVerifier` installs `BearerAuthBackend` + `AuthContextMiddleware` via `get_middleware()` but its `get_routes()` returns an empty list — zero OAuth discovery endpoints, no `/.well-known/oauth-*` routes. MCP clients with a static `Authorization: Bearer <api_key>` header in `.mcp.json` use it directly — no OAuth dance, no "Authenticate" click. `ApiKeyTokenVerifier.verify_token` funnels into `resolve_user_from_api_key` (HMAC-SHA256 → Firestore collection group query, 5-min cache, rate limited). Tool handlers read the authenticated user via `get_user_id(ctx)` which calls `get_access_token()` from `fastmcp.server.dependencies`.

**Key files**: `auth/api_key_auth.py` (`ApiKeyTokenVerifier`, `resolve_user_from_api_key()` HMAC→Firestore, `get_user_id(ctx)` for tool handlers), `config.py` (env vars). **Client config** (`.mcp.json`): `type: "http"`, `url: ".../mcp"`, `headers: { "Authorization": "Bearer <api_key>" }`.

## Tools

`get_trips`, `get_trip_plans`, `get_trip_context` | `create_trip`, `delete_trip`, `update_trip_settings` | `create_plan`, `promote_plan`, `delete_plan` | `add_node`, `update_node`, `delete_node` | `add_edge`, `delete_edge` | `add_action`, `list_actions`, `delete_action` | `find_places` | `find_flights`. Shared `DAGService` + `PlanService` for mutations, shared `format_trip_context()` for context. `add_action` takes flattened place params (`place_name`, `place_id`, `place_lat`, `place_lng`, `place_category`) and requires `place_id` when `type='place'`. `find_flights` takes IATA codes + date; supports one-way and round-trip.

## Tool Response Shape Contract

Every `@mcp.tool()` returns one of five envelopes. New tools MUST follow this pattern so agent code can parse responses generically (locked by `mcpserver/tests/test_tools_contract.py`):

| Category | Shape | Examples |
|---|---|---|
| **Create / update** | `{<resource>: {id, ...}}` (plus optional metadata) | `add_node → {node, edge}`, `update_node → {node}`, `add_edge → {edge}`, `add_action → {action}`, `create_plan → {plan, nodes_cloned, edges_cloned, actions_cloned}`, `create_trip → {trip, plan}` |
| **Delete** | `{deleted: true, <resource>_id: "...", ...side-effect counts}` | `delete_trip → {deleted, trip_id}`, `delete_plan → {deleted, plan_id}`, `delete_node → {deleted, node_id, deleted_edge_count, reconnected_edges, participant_ids_cleaned}`, `delete_edge → {deleted, edge_id}`, `delete_action → {deleted, action_id, node_id}` |
| **List** | `{<resources>: [...]}` | `get_trips → {trips}`, `get_trip_plans → {trip_id, active_plan_id, plans}` |
| **Search / misc** | `{<field>: [...], ...metadata}` | `find_places → {query, center, places}`, `find_flights → {origin, destination, date, outbound, return_flights?}`, `update_trip_settings → {trip_id, settings}`, `promote_plan → {plan_id, status, previous_active_plan_id}` |
| **Text comprehension** | plain `str` | `get_trip_context`, `list_actions` — intentionally markdown for prose display, NOT JSON |

`find_places` specifically returns structured JSON (not markdown) so callers can feed `places[i].place_id` directly into `add_action(type='place')` without reparsing prose.

## MCP-Specific Behaviors (Diverge From Backend On Purpose)

- `create_trip` bundles an initial active plan named "Main Route" so `add_node` works immediately. Backend's `POST /trips` stays planless — web flow creates the first plan inside `import_build`.
- `McpTripService.get_trip_context` reshapes each node dict before feeding it to `build_agent_trip_context` (which calls `enrich_dag_times` then `format_trip_context`). The reshape MUST preserve `duration_minutes` — the `Node` model uses that name; `enrich_dag_times` reads it at `shared/shared/dag/time_inference.py:203`. An earlier bug emitted `duration_hours` instead, silently zeroing every user-set duration and breaking drive-cap + overnight-hold propagation for MCP callers. Guarded by `mcpserver/tests/test_trip_service_get_trip_context.py`.

## Shared Agent + MCP Behavior

Both the in-app agent (`ToolExecutor`) and MCP server use `DAGService.update_node_only` for `update_node` — updates only the target node, no propagation. Polylines on connected edges are recalculated if `lat_lng` changes. The REST API (`backend/src/api/nodes.py`) uses `update_node_with_impact_preview` for the manual map UI, which returns an enrichment diff (`estimated_shifts`, `new_conflicts`, `new_overnight_holds`) so the edit form can show live impact inline — no modal. Overlapping tools (`add_node`, `update_node`, `delete_node`, `add_edge`, `delete_edge`, `find_flights`) call the same underlying service methods and return the same dict shapes.

## Auth Gates (`mcpserver/src/tools/_helpers.py`)

Every `@mcp.tool()` calls exactly one on its first line — Gate A `resolve_trip_plan` (editor: admin/planner + plan resolution), Gate B `resolve_trip_participant` (any participant + plan resolution, used by `add_action` / `list_actions` / `get_trip_context`), Gate C `resolve_trip_admin` (admin only, no plan resolution), Gate D `resolve_authenticated` (auth only, for `create_trip` / `find_places` / `find_flights`). `resolve_authenticated` internally calls the `get_user_id(ctx)` helper from `mcpserver/src/auth/api_key_auth.py` (which reads `get_access_token().client_id`); other gates resolve their user via the same path. The gates call four public instance methods on the shared `TripService` — `resolve_participant(trip_id, user_id) -> (trip_dict, role_str)` (the consolidated fetch+verify entry point), plus `verify_participant(trip_dict, user_id) -> role_str`, `require_editor(role_str)`, `require_admin(role_str)` — which live in `shared/shared/services/trip_service.py` so backend and MCP both inherit them. These methods are intentionally public despite gating authorization; do NOT prefix with underscore or delete during refactors. The backend still uses its own free-function `require_role(Trip, user_id, *roles)` in `backend/src/auth/permissions.py` — the two code paths diverge intentionally because the backend has the `Trip` pydantic model in hand at its handlers while MCP works with raw dicts. Guarded by `shared/tests/test_trip_service_role_gates.py`.

## MCP `tool_error_guard` Masks Runtime Errors

`mcpserver/src/tools/_helpers.py` decorates every `@mcp.tool()` with `tool_error_guard` (or `_text`), which catches every exception type — including `AttributeError`, `TypeError`, etc. — and returns `{"error": {"code": "INTERNAL_ERROR", "message": "Internal error while handling request"}}` to the client. That means a broken service call (missing method, bad signature) looks identical to a legitimate internal error from the outside. When an MCP tool mysteriously returns `INTERNAL_ERROR`, grep the server logs for `Unhandled error in MCP tool <name>` — the real stack trace is there. This is the mechanism by which the deleted `require_editor`/`require_admin` methods (then underscore-prefixed, which is part of why the merge dropped them silently) disabled authorization on every write tool for an extended period.
