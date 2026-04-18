# MCP Server — End-to-End Smoke Test

Drives a live MCP server through a realistic trip-planning scenario that
exercises **every one of the 19 tools** and asserts the server + Firestore
left nothing behind. Use this after changes to `mcpserver/`,
`shared/shared/services/`, or any tool contract you want to validate
against a real process.

Not part of the pytest suite — it needs a running MCP server, real
Firestore credentials, and a live Google Places / Routes / Flights API.
Unit tests live in `mcpserver/tests/` and should not depend on any of
those.

Uses the official `fastmcp.Client` for transport — session/auth/SSE
parsing/structured-result unpacking are handled by the framework, so the
runner is a thin scenario script (see `run.py`).

## What it does

1. Lists existing trips (captures their IDs to **not touch**).
2. `create_trip` → `add_node × 5` (Tokyo, Kyoto, Osaka, Nara, Hiroshima) →
   `add_edge × 4` (transit, drive, flight).
3. `find_places` for a real Osaka ramen spot → `add_action(type='place')`
   using the returned `place_id`.
4. Mutations: rename, extend stay, nudge coordinates.
5. Actions: `note`, `todo`, `place`; `list_actions`; `delete_action`.
6. `find_flights`, `update_trip_settings`.
7. Plan versioning: `create_plan` (clone) → `promote_plan` (swap) →
   `delete_plan`.
8. Structural deletions: `delete_edge`, `delete_node`.
9. `delete_trip` → re-list trips to verify the test trip is gone AND that
   the preserved trips are still present.
10. Walks `trips/{trip_id}` in Firestore recursively and asserts every
    subcollection is empty.

Exits 0 on success, non-zero on any issue.

## Prerequisites

- Activate the `travel-app` conda env — `python` must resolve to the one
  with project deps (httpx, google-cloud-firestore, etc.). `uv run`
  bypasses the conda env and creates an empty venv, so it won't work here.
  Verify with `which python` → `.../envs/travel-app/bin/python`.
- MCP server running locally on `http://localhost:8080` (or reachable via
  `STB_MCP_URL`). Start it with:
  ```
  python -m uvicorn mcpserver.src.main:app --reload --port 8080
  ```
- A valid API key. Create one at the web app: **Profile → API Keys**.
  (Only shown once — copy immediately.)
- Google Application Default Credentials for the Firestore cleanup check
  (skip the check with `--skip-firestore-verify` if you don't have them):
  ```
  gcloud auth application-default login
  ```

## Run

From the repo root, with the `travel-app` conda env active:

```bash
# Simplest (env vars):
export STB_MCP_API_KEY="stb_your_key_here"
python mcpserver/e2e/run.py

# Or pass via CLI:
python mcpserver/e2e/run.py --api-key stb_... --url http://localhost:8080/mcp

# Without Firestore verification (no ADC needed):
python mcpserver/e2e/run.py --skip-firestore-verify
```

Takes ~30 seconds on a warm server. Expect ~40 tool calls.

## Reading the output

Every tool invocation is printed as `### tool_name — context` followed by
the parsed response. The summary at the end:

```
============================================================
TOOLS CALLED (19/19): [...]
============================================================
ISSUES (0):

Result: PASS (exit 0)
```

`TOOLS CALLED (N/19)` should always be `19/19`. Anything less means a
tool was never reached — usually because an earlier step failed to extract
an ID from the response shape.

## Typical failures

- **`TOOLS CALLED < 19`** — a response-shape assertion failed. Check the
  `[ISSUE] could not extract …` lines earlier in the log.
- **Transit edges show `travel_time_hours: 0.0, distance_km: null`** — the
  Routes API has no transit coverage for that corridor (known gap for
  Japan). Not a regression.
- **`Firestore residue under trips/...`** — `delete_trip` didn't cascade
  correctly. Check `DAGService.delete_plan` and `TripService.delete_trip`.
- **`preserved trips disappeared`** — catastrophic bug; the test is
  touching trips it shouldn't. Stop immediately.

## Extending the test

When adding a new MCP tool:
1. Add a call in `run.py` inside the existing phase that matches the
   tool's purpose (build, mutate, versioning, teardown).
2. If the tool returns a novel response shape, update `get_id()` paths
   and the `TOOLS CALLED` count in this README.
3. Re-run with `--skip-firestore-verify` first to iterate quickly, then
   with verification on before calling the change done.

Unit-level contracts for the response shapes live in
`mcpserver/tests/test_tools_contract.py`. The e2e test is the integration
check on top.
