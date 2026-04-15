# Analytics Implementation Reference

This document describes how product analytics works in Smart Travel Buddy. If
you need to fix, update, or extend analytics, read this first.

---

## TL;DR

- **Provider**: Firebase Analytics (GA4). No custom Firestore collections.
- **Frontend (Next.js)**: SDK-based events via `firebase/analytics`.
- **MCP server (Python)**: Server-side events via GA4 Measurement Protocol.
- **Backend (FastAPI)**: Does **not** emit analytics directly. Events that
  describe backend work (e.g. `import_build_completed`) are fired from the
  frontend after the backend returns, using data on the response.
- **Graceful degradation**: Missing env vars = full no-op (no errors, no
  warnings, no network calls).
- **Opt-out**: Authenticated users default on. A profile toggle mirrors the
  existing `location_tracking_enabled` pattern.

---

## Architecture (three pieces)

### 1. Frontend analytics library (`frontend/lib/analytics/`)

Everything the UI touches goes through **one barrel** — `@/lib/analytics`.
Components never import from Firebase directly. The module boundary is
enforced by only exporting typed helpers + the `AnalyticsProvider`.

```
frontend/lib/analytics/
├── client.ts              # AnalyticsClient interface + Firebase/Noop impls + factory
├── events.ts              # Typed event helpers (trackDagMutation, trackTripCreated, ...)
├── provider.tsx           # React Context provider + user_id/prefs sync
├── use-route-tracking.ts  # screen_view on pathname change
├── index.ts               # Barrel — the ONLY import path for components
└── events.test.ts         # Unit tests
```

### 2. GA4 Measurement Protocol service (`shared/shared/services/analytics_service.py`)

A tiny `AnalyticsService` class used by the MCP server (and available to any
other Python process that wants server-side analytics). Uses `httpx.AsyncClient`
to POST to `https://www.google-analytics.com/mp/collect`. Fire-and-forget —
never raises, always logs at WARNING on failure.

### 3. MCP tool instrumentation (`mcpserver/src/middleware/analytics.py`)

All MCP tool calls are tracked from exactly one interception point:
`AnalyticsMiddleware.on_call_tool`, registered on the FastMCP instance.
The middleware wraps every `@mcp.tool()` invocation, reads the tool name
from `context.message.name` and the authenticated user from
`get_access_token()`, then dispatches a `mcp_tool_called` event via
fire-and-forget. Auth gates and tool bodies contain zero analytics code.

---

## Environment variables

### Frontend (`frontend/.env.local`)

```bash
# Public (client-side). Get from Firebase Console > Project Settings >
# General > Your apps > Web app > SDK setup > Config.
# AUTH_DOMAIN and PROJECT_ID can be omitted in deploy integrations 
# as they default to the GCP PROJECT_ID.
NEXT_PUBLIC_FIREBASE_API_KEY=AIzaSy...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...

# REQUIRED for Analytics initialization
NEXT_PUBLIC_FIREBASE_APP_ID=1:1234567890:web:abcdef123456
NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=G-XXXXXXXXXX
```

**If `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID` is missing or empty:** the
singleton factory returns `NoopAnalyticsClient` — every `track*()` call is
silently dropped, zero network requests hit GA.

### MCP server (`mcpserver/.env`)

```bash
# Optional. Both required to enable analytics.
# GA_MEASUREMENT_ID: same G-XXXXXXXXXX value from Firebase console.
# GA_API_SECRET: Firebase console > Data streams > [web stream] >
#                Measurement Protocol API secrets > Create.
GA_MEASUREMENT_ID=G-XXXXXXXXXX
GA_API_SECRET=abc123secretvalue
```

**If either is missing:** `AnalyticsService.enabled` returns `False`, no HTTP
calls are made, no warnings logged. `mcp_tool_called` events are simply
dropped.

### Backend

Backend does **not** read any analytics env vars. All analytics for
web-triggered actions is emitted from the frontend.

---

## Frontend — Detailed Flow

### Client singleton & no-op factory (`client.ts`)

```typescript
// Factory logic (paraphrased)
export function getAnalyticsClient(): AnalyticsClient {
  if (singleton) return singleton;
  const measurementId = process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID;
  const appId = process.env.NEXT_PUBLIC_FIREBASE_APP_ID;

  if (typeof window === "undefined" || !measurementId || !appId) {
    singleton = new NoopAnalyticsClient();  // SSR or missing critical env → no-op
  } else {
    singleton = new FirebaseAnalyticsClient(measurementId);
  }
  return singleton;
}
```

`FirebaseAnalyticsClient` uses **dynamic imports** (`await import("firebase/analytics")`)
so the ~40 KB analytics SDK isn't pulled into the SSR bundle. All SDK calls
go through an `initPromise` which explicitly calls `getFirebaseApp()` from
`@/lib/firebase` to ensure the Firebase App is initialized without race 
conditions. Queued writes (`setUserId`, `setUserProperties`) buffer until 
`isSupported()` + `getAnalytics()` resolve, then fire in order.

The `init()` process is wrapped in a `try/catch` to gracefully degrade if
ad-blockers or bad network conditions prevent the SDK from loading.

Params passed to `logEvent()` are sanitized:
- `null` / `undefined` dropped
- strings clamped to 100 chars (GA4's param value limit)
- non-primitive values stringified and clamped

### Typed event registry (`events.ts`)

All events and their param shapes live here. Components call one-liner
helpers like:

```typescript
import { trackTripCreated, trackDagMutation } from "@/lib/analytics";

trackTripCreated();
trackDagMutation({ source: "ui", action: "create", entity: "node", node_type: "hotel" });
```

**DO NOT** call `getAnalyticsClient().logEvent(...)` directly from a
component. Always add a typed helper in `events.ts` first. This keeps the
event schema in one file and lets TypeScript enforce param shapes.

### Provider (`provider.tsx`)

Rendered between `AuthProvider` and `APIProvider` in `app/providers.tsx`.
Two `useEffect` hooks run on every auth change:

1. **`setUserId` sync** — when `user.uid` changes, call `client.setUserId(uid)`.
   Guarded by `lastUserIdRef` so it only fires on actual changes.

2. **Opt-out preference sync** — when a user signs in, fetch `/users/me` and
   mirror `analytics_enabled` to:
   - `client.setEnabled(enabled)` → calls Firebase `setAnalyticsCollectionEnabled`
   - `client.setUserProperties({ analytics_enabled })` → GA user property for
     segmentation in reports

Guarded by `lastPrefsUidRef` + `AbortController` to prevent duplicate fetches.

### Route tracking (`use-route-tracking.ts`)

Hook subscribes to `usePathname()` and fires `screen_view` on each change. 
Instead of raw paths, it parses logical **screen names** for cleaner 
reporting in the GA4 dashboard:

- `screen_name` — a clean identifier (e.g., `trip_map`, `profile`, `trips_list`)
- `page_path` — the original raw pathname
- `trip_id` — extracted from `/trips/:tripId`
- `subroute` — extracted from `/trips/:tripId/:subroute` (e.g. `import`, `settings`)

Guarded by `lastPathRef` so it fires exactly once per route change, not on
unrelated re-renders.

### Components

Files touched for event emission (see `events.ts` for the full list of helpers
they use):

| File | Events emitted |
|---|---|
| `app/page.tsx` | `trips_list_loaded`, `trip_opened` |
| `app/sign-in/page.tsx` | `signin_initiated` |
| `app/profile/page.tsx` | `profile_updated`, `analytics_toggled`, `location_tracking_toggled` |
| `app/trips/new/page.tsx` | `trip_created` |
| `app/trips/[tripId]/page.tsx` | `dag_mutation` (ui), `node_action`, `view_changed`, `timeline_zoom_changed`, `path_mode_toggled`, `node_opened`, `edge_opened`, `timing_shifted`, `plan_created` |
| `app/trips/[tripId]/import/page.tsx` | `import_message_sent`, `import_build_started`, `import_build_completed`, `import_build_failed`, `dag_mutation` (import_build) |
| `app/trips/[tripId]/settings/page.tsx` | `plan_created`, `plan_promoted`, `plan_deleted`, `invite_generated`, `participant_role_changed` |
| `app/invite/[tripId]/[token]/page.tsx` | `invite_accepted` |
| `components/ui/bottom-nav.tsx` | `nav_tab_clicked` |
| `components/chat/agent-overlay.tsx` | `agent_opened`, `agent_closed`, `agent_message_sent`, `agent_response_received`, `dag_mutation` (agent) |
| `components/map/pulse-button.tsx` | `pulse_initiated`, `pulse_sent`, `pulse_error` |
| `components/dag/divergence-resolver.tsx` | `divergence_resolved` |

---

## MCP server — Detailed Flow

### `AnalyticsService` (`shared/shared/services/analytics_service.py`)

```python
class AnalyticsService:
    def __init__(self, http_client: httpx.AsyncClient,
                 measurement_id: str | None, api_secret: str | None) -> None: ...

    @property
    def enabled(self) -> bool:
        return bool(self._measurement_id and self._api_secret)

    async def track_event(self, user_id: str, event_name: str,
                          params: dict[str, Any] | None = None,
                          analytics_enabled: bool = True) -> None: ...
```

Payload sent to `https://www.google-analytics.com/mp/collect`:

```json
{
  "client_id": "<firebase_uid>",
  "user_id": "<firebase_uid>",
  "events": [
    {
      "name": "mcp_tool_called",
      "params": { "tool_name": "add_node", "trip_id": "t_xyz", "plan_id": "p_abc", "result": "success" }
    }
  ]
}
```

Notes:
- `client_id` is **required** by GA4 MP. We set it to the Firebase UID.
- `user_id` is optional but we set it to the same UID for cross-device
  attribution with the frontend.
- `pseudo_user_id` is **not a request field** — it's a BigQuery export
  column name for whatever `client_id` we send.
- `timeout=5s`, errors caught and logged at WARNING — the service never
  raises.
- `None` values in params are dropped (`_clean_params`) because GA4 rejects
  `null`.
- `track_event()` itself is `async` — it `await`s the httpx POST. The
  fire-and-forget dispatch happens one layer up in
  `AnalyticsMiddleware._dispatch`, which schedules `track_event` via
  `asyncio.create_task`. Callers that *do* want to block on the POST
  (e.g. an outbox draining script) can still `await` the coroutine
  directly.

### Instrumentation via `AnalyticsMiddleware`

Registered once on `mcp` in `mcpserver/src/main.py`:

```python
from mcpserver.src.middleware.analytics import AnalyticsMiddleware
mcp.add_middleware(AnalyticsMiddleware())
```

FastMCP's middleware chain calls `on_call_tool(context, call_next)` for
every tool invocation, after `BearerAuthBackend` has populated the
authenticated user in the request ContextVar. The middleware:

1. `await call_next(context)` to execute the full tool (auth gate + body).
2. In a `finally` block, reads `context.message.name` (tool name),
   `context.message.arguments` (raw inputs — `trip_id` / `plan_id` are
   extracted when present), and `get_access_token().client_id` (user id).
3. Dispatches `mcp_tool_called` to `AnalyticsService.track_event` via
   `asyncio.create_task`.

If `call_next` raises, the event is still fired with `result: "error"` and
the exception re-raises so the tool's own error handling runs unchanged.

The four auth gates in `tools/_helpers.py` — `resolve_trip_plan`,
`resolve_trip_participant`, `resolve_trip_admin`, `resolve_authenticated`
— do only auth and plan resolution. Adding a new `@mcp.tool()` gets
tracking automatically; there is no per-tool wiring.

### Fire-and-forget dispatch

`AnalyticsMiddleware._dispatch()` is a synchronous helper called from the
async hook's `finally` block. It schedules the GA4 POST as a background
task via `asyncio.create_task()` and returns immediately. The tool
response is sent to the MCP client without waiting for the HTTP round-trip.

**Why fire-and-forget:** the GA4 Measurement Protocol endpoint returns 2xx
regardless of payload validity, so blocking each tool response on the
`~50–300ms` HTTP round-trip adds latency with no observability benefit.

**The strong-reference set** (`_PENDING_TRACKING_TASKS: set[asyncio.Task]`):
`asyncio.create_task()` only holds a weak reference to the task. If nothing
else keeps a strong reference, the event loop's garbage collector can
collect the task mid-flight — stdlib docs call this out explicitly. The
middleware module adds each task to a set and removes it via a
`done_callback`, so the task stays alive until the POST completes.

**The done-callback** (`_on_tracking_task_done`):
1. Removes the task from the strong-reference set.
2. If the task raised, logs at WARNING with `exc_info` so operators still
   see analytics-layer failures. (The service itself already has
   `try/except Exception` around the POST — this is defence in depth for
   any future codepath that raises outside the try.)
3. Cancelled tasks are ignored.

**Shutdown tradeoff:** if the MCP server process is killed while a task
is in-flight, the event is lost. This is acceptable for analytics — we
prioritise tool response latency over 100% event-delivery guarantees.
For critical audit-log use cases, prefer the blocking path or an outbox
queue.

### Wiring in `mcpserver/src/main.py`

```python
# In app_lifespan:
analytics_service = AnalyticsService(
    http_client,
    measurement_id=os.environ.get("GA_MEASUREMENT_ID"),
    api_secret=os.environ.get("GA_API_SECRET"),
)

yield AppContext(
    ...,
    analytics_service=analytics_service,
    ...,
)
```

Tools access it via `ctx.lifespan_context.analytics_service`, but in
practice only `AnalyticsMiddleware` touches it directly.

---

## User opt-out

### Backend storage
`User.analytics_enabled: bool = True` (`shared/shared/models/user.py`).
PATCH `/users/me` accepts `analytics_enabled` and persists to Firestore.

### Frontend toggle
`app/profile/page.tsx` has a toggle under "Preferences" that mirrors the
existing location-tracking UX. On change:

1. **Turning OFF**: fire `trackAnalyticsToggled(false)` **before** calling
   `client.setEnabled(false)` so the OFF event itself is captured.
2. **Turning ON**: call `client.setEnabled(true)` **first**, then fire
   `trackAnalyticsToggled(true)` so the ON event goes through.

### Provider sync
When a user signs in, `AnalyticsProvider` fetches `/users/me` and calls
`client.setEnabled(analytics_enabled)` + sets `user_properties.analytics_enabled`.

### MCP server
Currently the MCP server does **not** consult `User.analytics_enabled` before
emitting `mcp_tool_called`. This is a known gap — opt-out currently only
affects web events. To respect opt-out for MCP tools, the auth gate would
need to read the user doc and pass `analytics_enabled` through to
`track_event()`. The `analytics_enabled` param already exists on
`AnalyticsService.track_event()` for this purpose.

---

## Event registry (v1)

### Single consolidated DAG mutation event

Instead of `node_created` / `node_edited` / `edge_added` / ... (which would
blow through GA4's 500-event-name limit), we emit one event with rich params.
This mirrors GA4's own pattern for ecommerce events.

```typescript
trackDagMutation({
  source: "ui" | "agent" | "import_build",
  action: "create" | "edit" | "delete" | "branch" | "split" | "insert",
  entity: "node" | "edge",
  node_type?: string,       // when entity === "node"
  travel_mode?: string,     // when entity === "edge"
  fields_changed?: string,  // comma-separated, when action === "edit"
});
```

**Source attribution:**
- `source: "ui"` — fired from the REST success path in the UI component.
- `source: "agent"` — `AgentOverlay` iterates `AgentResponse.actions_taken`
  from the backend and emits one event per action.
- `source: "import_build"` — `import/page.tsx` iterates
  `BuildDagResponse.actions_taken` and emits one event per action.
- MCP tool mutations are **not** re-fired as `dag_mutation` — they're
  captured in the separate `mcp_tool_called` funnel, so we don't
  double-count.

### Full event list

| Event | Params | Fired from |
|---|---|---|
| `screen_view` | `screen_name`, `page_path`, `trip_id?`, `subroute?` | route-tracking hook (auto) |
| `signin_initiated` | `provider` | sign-in page |
| `signout` | — | auth provider |
| `profile_updated` | `field` | profile page |
| `analytics_toggled` | `enabled` | profile page |
| `location_tracking_toggled` | `enabled` | profile page |
| `trips_list_loaded` | `count` | home |
| `trip_opened` | `trip_id`, `role?` | home |
| `trip_created` | — | new trip page |
| `plan_created` | — | trip page / settings |
| `plan_promoted` | — | settings |
| `plan_deleted` | — | settings |
| `dag_mutation` | see above | node/edge callsites |
| `node_action` | `action`, `action_type`, `source` | trip page |
| `view_changed` | `from`, `to` | trip page |
| `timeline_zoom_changed` | `level` | trip page |
| `path_mode_toggled` | `mode` | trip page |
| `node_opened` | `node_type?` | map / timeline |
| `edge_opened` | `travel_mode?` | map / timeline |
| `timing_shifted` | `node_count` | node detail sheet |
| `import_message_sent` | `length` | import page |
| `import_build_started` | — | import page |
| `import_build_completed` | `node_count`, `edge_count`, `duration_ms?` | import page |
| `import_build_failed` | `reason?` | import page |
| `import_retry` | — | import page |
| `agent_opened` | — | agent overlay |
| `agent_closed` | — | agent overlay |
| `agent_message_sent` | `length` | agent overlay |
| `agent_response_received` | `action_count`, `preference_count`, `duration_ms?` | agent overlay |
| `invite_generated` | `role` | settings |
| `invite_accepted` | `role?` | invite claim page |
| `divergence_resolved` | — | divergence resolver |
| `participant_role_changed` | `new_role` | settings |
| `pulse_initiated` / `pulse_sent` / `pulse_error` | `code?` on error | pulse button |
| `nav_tab_clicked` | `tab` | bottom nav |
| `mcp_tool_called` | `tool_name`, `trip_id?`, `plan_id?`, `result` | **MCP server gates** |

### Intentionally NOT tracked
- Map camera pans/zooms — too noisy, low signal, would blow param budget.
- Hover events — too noisy.
- Unauthenticated navigation — GA's built-in Firebase-Analytics auto-screen
  tracking was not enabled, so only authenticated flows generate events.

---

## Testing

### Frontend (`frontend/lib/analytics/events.test.ts`)
Vitest-based. Covers:
- Factory returns no-op when `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID` is missing.
- Typed helpers forward the right event name + params to `logEvent`.
- Sanitization (null/undefined dropping, 100-char clamp).

Run: `cd frontend && pnpm test`.

### MCP / shared (`shared/tests/test_analytics_service.py`)
Pytest-based. Covers:
- No-op when `measurement_id` / `api_secret` missing (either or both).
- No-op when `analytics_enabled=False`.
- No-op when `user_id` is empty.
- Correct payload shape sent to the endpoint.
- `None` params dropped from `params`.
- Never raises on HTTP timeout or unexpected exceptions.

Run: `python -m pytest shared/tests/test_analytics_service.py -v`.

---

## Verification checklist (smoke test)

1. **Frontend no-op**: unset `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID`, run
   `pnpm dev`, exercise the app → zero network calls to
   `google-analytics.com`, console clean.
2. **Frontend live**: set the env var, add `?debug_mode=1` in GA DebugView,
   navigate → events appear within ~30s with correct `user_id` and params.
3. **Opt-out E2E**: toggle analytics off in profile → refresh → new events
   not sent. Toggle on → events resume without restart.
4. **Typecheck**: `cd frontend && pnpm exec tsc --noEmit` green.
5. **Lint**: `cd frontend && pnpm lint` — no new errors introduced by
   analytics files.
6. **MCP no-op**: unset `GA_MEASUREMENT_ID` / `GA_API_SECRET`, call any tool
   from Claude Desktop → no outbound HTTP, no log warnings.
7. **MCP live**: set both, call `add_node` → `mcp_tool_called` event with
   `tool_name=add_node` appears in DebugView.

---

## Common gotchas

### "My new event doesn't appear in GA"
1. Check DebugView (`?debug_mode=1` in the frontend URL) first — production
   reports lag 24-48h.
2. Verify the helper is exported from `events.ts` and the import path is
   `@/lib/analytics` (not a deep import).
3. Check that `AnalyticsProvider` wraps the component tree (`app/providers.tsx`).
4. Confirm the helper is actually called — a `try/catch` around the
   triggering code could be swallowing the call site.

### "I added a new tool but no analytics"
`AnalyticsMiddleware` tracks every `@mcp.tool()` automatically — if the
tool is registered on the `mcp` instance it is tracked. If events are
missing for a specific tool, verify `mcp.add_middleware(AnalyticsMiddleware())`
still runs in `main.py` and that the tool module is actually imported
(tools register via import side-effect).

### "Event params stopped showing up"
GA4 limits:
- 40 char max per event name.
- 25 params max per event.
- 100 char max per string param value (we clamp in `sanitizeParams`).
- 40 char max per param name.
- 500 distinct event names per property (not per user).

If you see event firing but params missing, check these.

### "Firebase Analytics isn't initializing"
1. `FirebaseAnalyticsClient` requires a live `FirebaseApp` from `getApp()`, which is initialized in `frontend/lib/firebase.ts`.
2. **CRITICAL**: GA4 initialization via the Firebase SDK requires both `measurementId` AND `appId` in the `firebaseConfig`. If either is missing from `initializeApp()`, `getAnalytics()` may fail silently or logs "appId is required".
3. Verify `firebase/analytics` and `firebase/app` are both present in `package.json` and at compatible versions.
4. Check that the `AnalyticsProvider` wraps the component tree (`app/providers.tsx`).

### "My MCP tools are responding but no events arrive"
1. Verify **BOTH** `GA_MEASUREMENT_ID` and `GA_API_SECRET` are set in the environment.
2. GA4 Measurement Protocol (server-side) requires an API Secret to accept events. If `GA_API_SECRET` is blank, the `AnalyticsService` becomes a no-op.
3. Check the MCP server logs for `GA4 track_event failed` warnings.

### "Params with `undefined` or `null` silently disappear"
By design. `sanitizeParams` (frontend) and `_clean_params` (MCP) drop
them because GA4 rejects null and undefined. If you need to record
"absent" explicitly, use a sentinel string like `"none"`.

### "MCP tool responded but the event never arrived in GA4"
Expected in two scenarios, both by design:
1. **Process killed mid-flight.** `AnalyticsMiddleware` schedules the POST
   as a background task and returns. If the MCP server is SIGKILL'd (Cloud
   Run cold shutdown, OOM, local Ctrl-C) before the task resolves, the
   event is lost. Cloud Run's graceful-shutdown window (~10s) usually
   covers a 5s httpx timeout, but kill -9 won't.
2. **Pending task GC.** If `_PENDING_TRACKING_TASKS.add(task)` is ever
   removed, `asyncio.create_task` only holds a weak ref and the event
   loop's GC can collect the task mid-flight. The strong-reference set
   is load-bearing — keep it.

If you need guaranteed delivery (e.g. an audit-log use case), `await
app.analytics_service.track_event(...)` directly from the tool body
instead of relying on the middleware.

---

## File map (quick reference)

```
frontend/
├── lib/analytics/
│   ├── client.ts               # Firebase SDK wrapper + no-op factory
│   ├── events.ts               # Typed helpers + event registry
│   ├── events.test.ts          # Unit tests
│   ├── index.ts                # Barrel export
│   ├── provider.tsx            # React Context + user_id/prefs sync
│   └── use-route-tracking.ts   # screen_view on pathname change
├── app/
│   ├── providers.tsx           # AnalyticsProvider wired here
│   └── profile/page.tsx        # Opt-out toggle
└── .env.local.example          # NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=

shared/
├── shared/
│   ├── models/user.py          # analytics_enabled field
│   └── services/
│       ├── __init__.py         # Exports AnalyticsService
│       └── analytics_service.py # MP client
└── tests/test_analytics_service.py

backend/
└── src/api/users.py            # PATCH /users/me accepts analytics_enabled

mcpserver/
├── src/
│   ├── main.py                           # AnalyticsService + middleware wiring
│   ├── middleware/analytics.py           # on_call_tool fires mcp_tool_called
│   └── tools/_helpers.py                 # Auth gates only, no analytics
└── .env.example                          # GA_MEASUREMENT_ID=, GA_API_SECRET=
```

---

## Extending the system

### Adding a new frontend event

1. Add a typed helper to `frontend/lib/analytics/events.ts`:
   ```typescript
   export function trackWidgetClicked(widget_id: string): void {
     track("widget_clicked", { widget_id });
   }
   ```
2. Import and call from the component:
   ```typescript
   import { trackWidgetClicked } from "@/lib/analytics";
   trackWidgetClicked(widget.id);
   ```
3. Add a test in `events.test.ts` mirroring the existing pattern.
4. Document the event in the registry table above.

### Adding a new MCP tool with tracking

Tracking is automatic for every `@mcp.tool()` — `AnalyticsMiddleware`
intercepts the call. Choose the gate for its auth semantics only:

```python
@mcp.tool()
@tool_error_guard
async def my_new_tool(trip_id: str, ctx: Context) -> dict:
    user_id, plan_id, _ = await resolve_trip_plan(ctx, trip_id)  # Gate A
    ...
```

### Changing an event's params

**Breaking change alert**: GA4 registers params on first sight; changing
the set of params for an existing event doesn't "rename" historical data.
Options:
- Add a new param (non-breaking) — just add it to the helper signature.
- Remove a param (mostly non-breaking) — old data still has it, new data
  doesn't.
- Rename a param (breaking) — use a new event name or a new param alongside
  the old one, and deprecate the old one in GA reports.

### Respecting opt-out on the MCP server

Not yet implemented. To add:
1. In `AnalyticsMiddleware._dispatch`, fetch the user's `analytics_enabled`
   field from Firestore (cache it with the 5-min API key cache if possible
   to avoid extra reads).
2. Pass it through to `track_event(..., analytics_enabled=<flag>)`.
3. Add a test covering the opt-out path for MCP.

---

## Out of scope

- **BigQuery export**: documented as a future one-toggle change in the
  Firebase console. Not currently enabled.
- **Custom in-app admin dashboard**: read GA reports directly.
- **Backend FastAPI analytics events**: backend does not emit events; the
  frontend emits enriched events after REST calls return.
- **A/B testing / Remote Config**: not integrated.
- **Cookie consent banner**: authenticated first-party analytics with an
  in-app opt-out is sufficient for the current scope. Revisit if launching
  to EU users with anonymous traffic.
