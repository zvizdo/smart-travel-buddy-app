# Backend Gotchas

## Request-Model Input Bounds

Validation lives on Pydantic request models, not in handlers. `backend/src/api/nodes.py` request models (`NodeUpdateRequest`, `CreateNodeRequest`, `ConnectedNodeRequest`, `BranchFromNodeRequest`) bound `lat: Field(ge=-90, le=90)`, `lng: Field(ge=-180, le=180)`, `duration_minutes: Field(ge=0, le=1440)`. `CreateInviteRequest.expires_in_hours: Field(ge=1, le=8760)`. `Participant.display_name: Field(max_length=200)` on the shared model, with a defensive `[:200]` slice in `invite_service.claim_invite` as belt-and-braces for callers that bypass the request model. Out-of-range coords persist silently and poison haversine/routing downstream, so enforce at the boundary. Mirror the same bounds on MCP tool signatures when adding new ones.

## Side-Effect Isolation On Authoritative Mutations

When a mutation is authoritative (participant actually joined Firestore, plan actually promoted) but triggers a best-effort side effect like a notification write, wrap the side effect in `try/except Exception` and log at WARNING with `exc_info=True`. Never let a notification failure cause a 5xx on the authoritative action — clients will retry the mutation and hit idempotent-reclaim branches. See `backend/src/api/invites.py:claim_invite` for the pattern.

## Structured Logging For Agent Parse Failures

`AgentService.build_dag` / `ongoing_chat` parse Gemini's JSON into `BuildDagReply` / `AgentReply`. On parse failure, log with `trip_id`, `plan_id`, `user_id` as structured fields and `exc_info=True`. Do NOT include `response_text` in logs — it can leak conversation content. The fallback summary/reply is `response_text or "<generic>"`.

## FastAPI PATCH Body Handling

When `null` is a meaningful "clear" signal (flex timing fields `arrival_time` / `departure_time` / `duration_minutes`), handlers MUST use `body.model_dump(exclude_unset=True)` and `updates.pop("client_updated_at", None)`. The old `{k: v for k, v in raw.items() if v is not None}` idiom drops explicit null clears → `ValueError("No fields to update")` → exception handler maps to 422.

Trip settings take the other approach: explicit `clear_no_drive_window` / `clear_max_drive_hours` sentinel booleans in `UpdateTripSettingsRequest`, because the nested dict is replaced wholesale on Firestore write (`document.update({"settings": current})`).

## Dev Backend Must Use `uvicorn --reload`

Run as `uv run uvicorn backend.src.main:app --reload --port 8000`. Pydantic silently ignores unknown request fields by default, so a stale process running pre-merge code drops new field names from the client without erroring — producing phantom "the fix is on disk but the UI still breaks" bugs where `git log` commits post-date the process start time. When a fix is verified on disk but user still reports the bug, check `ps -o lstart=` vs commit timestamps before suspecting the code.

## pytest Testpaths Include `mcpserver/tests`

`pyproject.toml` registers all three sub-project test roots (`shared/tests`, `backend/tests`, `mcpserver/tests`). A plain `pytest` from the repo root runs everything. The MCP tests can mock Firestore repos with `AsyncMock` and import `mcpserver.src.services.trip_service.TripService` directly — no live Firebase needed.
