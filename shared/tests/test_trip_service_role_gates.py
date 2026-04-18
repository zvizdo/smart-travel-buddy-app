"""Regression tests for the role-gate methods on the shared TripService.

Guards the fix for the silent-authorization bug where
`mcpserver/src/tools/_helpers.py` called `trip_service.require_editor(role)`
and `trip_service.require_admin(role)` — methods that had been dropped
during a merge. Every editor/admin-gated MCP tool raised `AttributeError`,
which `tool_error_guard` swallowed into a generic INTERNAL_ERROR response,
so the role check was effectively not enforced.

These tests pin two things:
  1. The methods exist on the shared `TripService`.
  2. Their authorization semantics match the backend's `require_role`.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from shared.services.trip_service import TripService


def _svc() -> TripService:
    # __new__ bypasses __init__ — these gates only read their arguments,
    # they never touch any injected repo, so we skip DI for unit testing.
    return TripService.__new__(TripService)


class TestVerifyParticipant:
    def test_returns_role_for_participant(self):
        trip = {"participants": {"u1": {"role": "admin"}}}
        assert _svc().verify_participant(trip, "u1") == "admin"

    def test_returns_planner_role(self):
        trip = {"participants": {"u1": {"role": "planner"}}}
        assert _svc().verify_participant(trip, "u1") == "planner"

    def test_returns_viewer_role(self):
        trip = {"participants": {"u1": {"role": "viewer"}}}
        assert _svc().verify_participant(trip, "u1") == "viewer"

    def test_non_participant_raises(self):
        trip = {"participants": {"u1": {"role": "admin"}}}
        with pytest.raises(PermissionError, match="not a participant"):
            _svc().verify_participant(trip, "stranger")

    def test_empty_participants_raises(self):
        with pytest.raises(PermissionError, match="not a participant"):
            _svc().verify_participant({"participants": {}}, "anyone")

    def test_missing_participants_key_raises(self):
        with pytest.raises(PermissionError, match="not a participant"):
            _svc().verify_participant({}, "anyone")


class TestRequireEditor:
    def test_admin_allowed(self):
        _svc().require_editor("admin")

    def test_planner_allowed(self):
        _svc().require_editor("planner")

    def test_viewer_rejected(self):
        with pytest.raises(PermissionError, match="admin, planner"):
            _svc().require_editor("viewer")

    def test_unknown_role_rejected(self):
        # Any string that isn't admin/planner should fail — the gate must not
        # fall open on unexpected values.
        with pytest.raises(PermissionError):
            _svc().require_editor("owner")


class TestRequireAdmin:
    def test_admin_allowed(self):
        _svc().require_admin("admin")

    def test_planner_rejected(self):
        with pytest.raises(PermissionError, match="admin"):
            _svc().require_admin("planner")

    def test_viewer_rejected(self):
        with pytest.raises(PermissionError, match="admin"):
            _svc().require_admin("viewer")

    def test_unknown_role_rejected(self):
        with pytest.raises(PermissionError):
            _svc().require_admin("planner_plus")


class TestResolveParticipant:
    """`resolve_participant` is the consolidated fetch-and-gate entry point
    used by the MCP tool helpers. It composes `_trip_repo.get_or_raise` with
    `verify_participant`; both error paths must surface unchanged."""

    @pytest.mark.asyncio
    async def test_returns_trip_dict_and_role(self):
        svc = _svc()
        trip = {"id": "t1", "participants": {"u1": {"role": "admin"}}}
        svc._trip_repo = MagicMock()
        svc._trip_repo.get_or_raise = AsyncMock(return_value=trip)

        got_trip, got_role = await svc.resolve_participant("t1", "u1")

        assert got_trip is trip
        assert got_role == "admin"
        svc._trip_repo.get_or_raise.assert_awaited_once_with("t1")

    @pytest.mark.asyncio
    async def test_non_participant_raises_permission_error(self):
        svc = _svc()
        svc._trip_repo = MagicMock()
        svc._trip_repo.get_or_raise = AsyncMock(
            return_value={"participants": {"owner": {"role": "admin"}}}
        )
        with pytest.raises(PermissionError, match="not a participant"):
            await svc.resolve_participant("t1", "stranger")

    @pytest.mark.asyncio
    async def test_missing_trip_bubbles_lookup_error(self):
        # `get_or_raise` is the only layer that knows about the trip's
        # existence — its LookupError must propagate unchanged so callers
        # can distinguish "no trip" from "no role."
        svc = _svc()
        svc._trip_repo = MagicMock()
        svc._trip_repo.get_or_raise = AsyncMock(
            side_effect=LookupError("Trip t1 not found")
        )
        with pytest.raises(LookupError, match="not found"):
            await svc.resolve_participant("t1", "u1")


class TestGatesArePresent:
    """The original bug was the methods not existing at all. Pin them so
    a future refactor that drops them fails fast at collection time rather
    than silently returning INTERNAL_ERROR at runtime."""

    @pytest.mark.parametrize(
        "method_name",
        [
            "verify_participant",
            "require_editor",
            "require_admin",
            "resolve_participant",
        ],
    )
    def test_method_exists(self, method_name: str):
        assert hasattr(TripService, method_name), (
            f"TripService.{method_name} is missing — MCP tool gates "
            f"depend on it. See mcpserver/src/tools/_helpers.py."
        )
        assert callable(getattr(TripService, method_name))
