"""Tests for relaxed Node model timing: optional arrival/departure, duration_minutes."""

from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from shared.models.node import LatLng, Node, NodeType


def _base_kwargs(**overrides) -> dict:
    kwargs = {
        "id": "n_test",
        "name": "Test",
        "type": NodeType.CITY,
        "lat_lng": LatLng(lat=0.0, lng=0.0),
        "created_by": "u_test",
    }
    kwargs.update(overrides)
    return kwargs


class TestNodeTimingRelaxation:
    def test_node_with_no_timing_fields_is_valid(self):
        node = Node(**_base_kwargs())
        assert node.arrival_time is None
        assert node.departure_time is None
        assert node.duration_minutes is None

    def test_node_with_only_duration_is_valid(self):
        node = Node(**_base_kwargs(duration_minutes=90))
        assert node.duration_minutes == 90
        assert node.arrival_time is None
        assert node.departure_time is None

    def test_node_with_only_arrival_is_valid(self):
        arrival = datetime(2026, 5, 1, 10, 0, tzinfo=UTC)
        node = Node(**_base_kwargs(arrival_time=arrival))
        assert node.arrival_time == arrival
        assert node.departure_time is None

    def test_node_with_only_departure_is_valid(self):
        departure = datetime(2026, 5, 1, 10, 0, tzinfo=UTC)
        node = Node(**_base_kwargs(departure_time=departure))
        assert node.departure_time == departure
        assert node.arrival_time is None

    def test_time_bound_node_is_valid(self):
        arrival = datetime(2026, 5, 1, 10, 0, tzinfo=UTC)
        departure = datetime(2026, 5, 1, 14, 0, tzinfo=UTC)
        node = Node(
            **_base_kwargs(
                arrival_time=arrival,
                departure_time=departure,
                duration_minutes=30,
            )
        )
        assert node.arrival_time == arrival
        assert node.departure_time == departure


class TestDepartureAfterArrivalInvariant:
    def test_departure_equal_to_arrival_rejected(self):
        t = datetime(2026, 5, 1, 10, 0, tzinfo=UTC)
        with pytest.raises(ValidationError, match="departure_time must be after"):
            Node(**_base_kwargs(arrival_time=t, departure_time=t))

    def test_departure_before_arrival_rejected(self):
        arrival = datetime(2026, 5, 1, 12, 0, tzinfo=UTC)
        departure = datetime(2026, 5, 1, 10, 0, tzinfo=UTC)
        with pytest.raises(ValidationError, match="departure_time must be after"):
            Node(**_base_kwargs(arrival_time=arrival, departure_time=departure))

    def test_departure_without_arrival_bypasses_check(self):
        departure = datetime(2026, 5, 1, 10, 0, tzinfo=UTC)
        node = Node(**_base_kwargs(departure_time=departure))
        assert node.departure_time == departure


class TestDurationMinutesBounds:
    def test_one_minute_is_valid(self):
        node = Node(**_base_kwargs(duration_minutes=1))
        assert node.duration_minutes == 1

    def test_fourteen_days_is_valid(self):
        node = Node(**_base_kwargs(duration_minutes=60 * 24 * 14))
        assert node.duration_minutes == 60 * 24 * 14

    def test_zero_rejected(self):
        with pytest.raises(ValidationError):
            Node(**_base_kwargs(duration_minutes=0))

    def test_negative_rejected(self):
        with pytest.raises(ValidationError):
            Node(**_base_kwargs(duration_minutes=-5))

    def test_over_fourteen_days_rejected(self):
        with pytest.raises(ValidationError):
            Node(**_base_kwargs(duration_minutes=60 * 24 * 14 + 1))
