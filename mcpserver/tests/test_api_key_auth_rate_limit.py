"""Regression tests for `_fail_tracker` memory bounds in api_key_auth.

Bug history: `_fail_tracker` was unbounded — an attacker sending N distinct
bogus bearer tokens grew the module-level dict by N entries (each ~200B),
so ~10M requests ≈ 2GB → Cloud Run OOM on the default instance. Pin:

  1. Tracker size stays ≤ `_FAIL_TRACKER_MAX_ENTRIES` under a flood.
  2. Stale entries (outside `_RATE_LIMIT_WINDOW`) get pruned before active
     entries when capacity eviction kicks in.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest
from mcpserver.src.auth import api_key_auth
from mcpserver.src.auth.api_key_auth import (
    _FAIL_TRACKER_MAX_ENTRIES,
    _RATE_LIMIT_WINDOW,
    resolve_user_from_api_key,
)


@pytest.fixture(autouse=True)
def _clear_module_state():
    # Hermetic: other tests (or prior runs) may have populated the dicts.
    api_key_auth._fail_tracker.clear()
    api_key_auth._cache.clear()
    yield
    api_key_auth._fail_tracker.clear()
    api_key_auth._cache.clear()


def _make_db_returning_no_match() -> MagicMock:
    """Firestore AsyncClient that never matches — every lookup fails."""
    db = MagicMock()

    async def _empty_stream():
        # Async generator that yields nothing → no matching doc.
        if False:
            yield

    query = MagicMock()
    query.where.return_value = query
    query.limit.return_value = query
    query.stream = lambda: _empty_stream()

    db.collection_group.return_value = query
    return db


class TestFailTrackerBounds:
    @pytest.mark.asyncio
    async def test_fail_tracker_bounded_under_flood(self):
        db = _make_db_returning_no_match()
        flood_size = _FAIL_TRACKER_MAX_ENTRIES + 500

        for i in range(flood_size):
            with pytest.raises(PermissionError):
                await resolve_user_from_api_key(db, f"bogus-key-{i}", "secret")

        assert len(api_key_auth._fail_tracker) <= _FAIL_TRACKER_MAX_ENTRIES, (
            f"_fail_tracker grew to {len(api_key_auth._fail_tracker)} "
            f"(cap is {_FAIL_TRACKER_MAX_ENTRIES}) — DoS vector regressed."
        )

    @pytest.mark.asyncio
    async def test_stale_entries_pruned_before_active(self, monkeypatch):
        # Freeze monotonic() so we can seed timestamps deterministically.
        current_time = [1000.0]
        monkeypatch.setattr(
            api_key_auth.time, "monotonic", lambda: current_time[0]
        )

        # Seed: fill the tracker to capacity with stale entries (outside window).
        stale_ts = current_time[0] - _RATE_LIMIT_WINDOW - 1
        for i in range(_FAIL_TRACKER_MAX_ENTRIES):
            api_key_auth._fail_tracker[f"stale_{i:04d}"] = [stale_ts]

        # One active entry with a fresh timestamp — must survive the sweep.
        active_hash = "active_key_hash"
        api_key_auth._fail_tracker[active_hash] = [current_time[0] - 1]

        # Flood with a new failure to trigger the eviction path.
        db = _make_db_returning_no_match()
        with pytest.raises(PermissionError):
            await resolve_user_from_api_key(db, "new-bogus-key", "secret")

        assert len(api_key_auth._fail_tracker) <= _FAIL_TRACKER_MAX_ENTRIES
        assert active_hash in api_key_auth._fail_tracker, (
            "Active entry was evicted while stale entries were still present."
        )

    @pytest.mark.asyncio
    async def test_existing_key_does_not_trigger_eviction(self, monkeypatch):
        # If a failing hash is already in the tracker, re-recording it must
        # not count as a new entry — otherwise legit retry traffic erodes
        # the cap faster than necessary.
        current_time = [2000.0]
        monkeypatch.setattr(
            api_key_auth.time, "monotonic", lambda: current_time[0]
        )

        # Fill to exactly the cap with active entries.
        for i in range(_FAIL_TRACKER_MAX_ENTRIES):
            api_key_auth._fail_tracker[f"active_{i:04d}"] = [current_time[0] - 1]

        # Re-record against an existing hash — should just append.
        existing = "active_0000"
        before_count = len(api_key_auth._fail_tracker[existing])
        api_key_auth._record_failure(existing, current_time[0])

        assert len(api_key_auth._fail_tracker) == _FAIL_TRACKER_MAX_ENTRIES
        assert len(api_key_auth._fail_tracker[existing]) == before_count + 1

    @pytest.mark.asyncio
    async def test_successful_auth_clears_failure_entry(self):
        # Verify the success path still prunes the tracker (unchanged behavior).
        from datetime import UTC, datetime

        db = MagicMock()

        doc = MagicMock()
        doc.reference.path = "users/u_test/api_keys/k_1"
        doc.reference.update = AsyncMock()

        async def _one_result():
            yield doc

        query = MagicMock()
        query.where.return_value = query
        query.limit.return_value = query
        query.stream = lambda: _one_result()
        db.collection_group.return_value = query

        # Pre-seed a failure for the hash that this key will resolve to.
        import hashlib
        import hmac

        key_hash = hmac.new(
            b"secret", b"valid-key", hashlib.sha256
        ).hexdigest()
        api_key_auth._fail_tracker[key_hash] = [0.0]

        user_id = await resolve_user_from_api_key(db, "valid-key", "secret")

        assert user_id == "u_test"
        assert key_hash not in api_key_auth._fail_tracker

        # Sanity: confirm ADT-agnostic call signature didn't drift.
        _ = datetime.now(UTC)
