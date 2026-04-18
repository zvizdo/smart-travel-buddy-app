"""Tests for the update_profile endpoint, focused on the location-deletion
fan-out when a user disables location tracking.

Earlier the handler awaited each ``location_repo.delete`` sequentially. For
users on many trips this serialised N round-trips to Firestore. The fixed
version fans out via ``asyncio.gather`` so total latency tracks the slowest
single delete instead of the sum.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from backend.src.api.users import UpdateProfileRequest, update_profile


def _make_deps(trips: list[dict]):
    user_service = MagicMock()
    user_service.update_user = AsyncMock(return_value={"id": "u1"})

    trip_service = MagicMock()
    trip_service.list_trips = AsyncMock(return_value=trips)

    location_repo = MagicMock()
    location_repo.delete = AsyncMock()

    return user_service, trip_service, location_repo


@pytest.mark.asyncio
async def test_disabling_location_deletes_for_every_trip():
    user_service, trip_service, location_repo = _make_deps([
        {"id": "t1"}, {"id": "t2"}, {"id": "t3"},
    ])
    body = UpdateProfileRequest(location_tracking_enabled=False)

    await update_profile(
        body, user={"uid": "u1"},
        user_service=user_service, trip_service=trip_service,
        location_repo=location_repo,
    )

    assert location_repo.delete.await_count == 3
    deleted_trip_ids = {
        call.kwargs["trip_id"] for call in location_repo.delete.await_args_list
    }
    assert deleted_trip_ids == {"t1", "t2", "t3"}


@pytest.mark.asyncio
async def test_no_trips_skips_delete_calls():
    user_service, trip_service, location_repo = _make_deps([])
    body = UpdateProfileRequest(location_tracking_enabled=False)

    await update_profile(
        body, user={"uid": "u1"},
        user_service=user_service, trip_service=trip_service,
        location_repo=location_repo,
    )

    location_repo.delete.assert_not_called()


@pytest.mark.asyncio
async def test_enabling_or_omitting_skips_delete():
    """Only the explicit ``False`` triggers cleanup. ``True`` and ``None`` skip it."""
    for setting in (True, None):
        user_service, trip_service, location_repo = _make_deps([{"id": "t1"}])
        body = UpdateProfileRequest(location_tracking_enabled=setting)

        await update_profile(
            body, user={"uid": "u1"},
            user_service=user_service, trip_service=trip_service,
            location_repo=location_repo,
        )

        location_repo.delete.assert_not_called()
        trip_service.list_trips.assert_not_called()


@pytest.mark.asyncio
async def test_deletes_run_in_parallel_not_sequentially():
    """Pin the optimization: deletes must be awaited concurrently via gather,
    not serialised. We assert this by stalling each delete on a single shared
    barrier — if the handler awaits them one-at-a-time, the barrier never
    releases and the test deadlocks (caught by ``asyncio.wait_for`` timeout)."""
    barrier_started = asyncio.Event()
    in_flight = 0
    max_in_flight = 0

    async def stalling_delete(*_args, **_kwargs):
        nonlocal in_flight, max_in_flight
        in_flight += 1
        max_in_flight = max(max_in_flight, in_flight)
        barrier_started.set()
        # Yield once so every gather'd coroutine has a chance to enter.
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        in_flight -= 1

    user_service, trip_service, location_repo = _make_deps([
        {"id": "t1"}, {"id": "t2"}, {"id": "t3"}, {"id": "t4"}, {"id": "t5"},
    ])
    location_repo.delete = AsyncMock(side_effect=stalling_delete)

    body = UpdateProfileRequest(location_tracking_enabled=False)

    await asyncio.wait_for(
        update_profile(
            body, user={"uid": "u1"},
            user_service=user_service, trip_service=trip_service,
            location_repo=location_repo,
        ),
        timeout=2.0,
    )

    assert barrier_started.is_set()
    # All five deletes were in flight simultaneously at the peak.
    assert max_in_flight == 5, (
        f"expected concurrent fan-out (5 in flight), got peak {max_in_flight} — "
        "handler likely reverted to sequential awaits"
    )
