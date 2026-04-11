"""Tests for shared.dag.time_inference.enrich_dag_times.

Most coverage lives in the JSON fixture so the TypeScript mirror can run
byte-for-byte the same scenarios. This file adds Python-specific invariants
(immutability, cycle fallback shape, etc.) on top of the fixture run.
"""

import json
from pathlib import Path

import pytest

from shared.dag.time_inference import enrich_dag_times

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "time_inference_cases.json"


def _load_fixture() -> list[dict]:
    with FIXTURE_PATH.open() as f:
        return json.load(f)


def _find(enriched: list[dict], node_id: str) -> dict:
    for n in enriched:
        if n["id"] == node_id:
            return n
    raise KeyError(node_id)


@pytest.mark.parametrize("case", _load_fixture(), ids=lambda c: c["name"])
def test_fixture_case(case: dict) -> None:
    enriched = enrich_dag_times(case["nodes"], case["edges"], case["trip_settings"])
    for expectation in case["expected"]:
        actual = _find(enriched, expectation["id"])
        for key, expected_value in expectation.items():
            assert actual.get(key) == expected_value, (
                f"[{case['name']}] node {expectation['id']} field {key}: "
                f"expected {expected_value!r}, got {actual.get(key)!r}"
            )
    conflict_id = case.get("expect_conflict_on")
    if conflict_id is not None:
        conflicted = _find(enriched, conflict_id)
        assert conflicted["timing_conflict"] is not None


class TestInputImmutability:
    def test_original_nodes_not_mutated(self):
        nodes = [
            {
                "id": "n_a",
                "name": "A",
                "type": "city",
                "timezone": "UTC",
                "departure_time": "2026-05-01T09:00:00+00:00",
            },
            {
                "id": "n_b",
                "name": "B",
                "type": "place",
                "timezone": "UTC",
            },
        ]
        edges = [{"from_node_id": "n_a", "to_node_id": "n_b", "travel_mode": "drive", "travel_time_hours": 1}]
        enrich_dag_times(nodes, edges, {})
        assert "arrival_time" not in nodes[1]
        assert "duration_minutes" not in nodes[1]
        assert "arrival_time_estimated" not in nodes[0]


class TestStartNodeSemantics:
    def test_start_with_only_departure_uses_departure_as_arrival(self):
        nodes = [
            {
                "id": "n_start",
                "name": "Start",
                "type": "place",
                "timezone": "UTC",
                "departure_time": "2026-05-01T09:00:00+00:00",
            },
        ]
        enriched = enrich_dag_times(nodes, [], {})
        assert enriched[0]["arrival_time"] == "2026-05-01T09:00:00+00:00"
        assert enriched[0]["arrival_time_estimated"] is True
        assert enriched[0]["is_start"] is True
        assert enriched[0]["is_end"] is True


class TestTopologyFlags:
    def test_is_start_and_is_end_derived_from_edges(self):
        nodes = [
            {"id": "a", "name": "A", "type": "place"},
            {"id": "b", "name": "B", "type": "place"},
            {"id": "c", "name": "C", "type": "place"},
        ]
        edges = [
            {"from_node_id": "a", "to_node_id": "b", "travel_mode": "drive", "travel_time_hours": 1},
            {"from_node_id": "b", "to_node_id": "c", "travel_mode": "drive", "travel_time_hours": 1},
        ]
        enriched = enrich_dag_times(nodes, edges, {})
        a, b, c = enriched
        assert (a["is_start"], a["is_end"]) == (True, False)
        assert (b["is_start"], b["is_end"]) == (False, False)
        assert (c["is_start"], c["is_end"]) == (False, True)


class TestDefaults:
    def test_missing_duration_falls_back_to_30(self):
        nodes = [
            {
                "id": "n",
                "name": "N",
                "type": "place",
                "timezone": "UTC",
                "arrival_time": "2026-05-01T09:00:00+00:00",
            }
        ]
        enriched = enrich_dag_times(nodes, [], {})
        assert enriched[0]["duration_minutes"] == 30
        assert enriched[0]["duration_estimated"] is True

    def test_user_duration_is_kept(self):
        nodes = [
            {
                "id": "n",
                "name": "N",
                "type": "place",
                "timezone": "UTC",
                "arrival_time": "2026-05-01T09:00:00+00:00",
                "duration_minutes": 45,
            }
        ]
        enriched = enrich_dag_times(nodes, [], {})
        assert enriched[0]["duration_minutes"] == 45
        assert enriched[0]["duration_estimated"] is False


class TestFloatingNode:
    def test_orphan_duration_only_node_stays_floating(self):
        nodes = [
            {
                "id": "n",
                "name": "Floating",
                "type": "place",
                "timezone": "UTC",
                "duration_minutes": 120,
            }
        ]
        enriched = enrich_dag_times(nodes, [], {})
        assert enriched[0]["arrival_time"] is None
        assert enriched[0]["departure_time"] is None
        assert enriched[0]["is_start"] is True
        assert enriched[0]["is_end"] is True


class TestDriveHoursCounter:
    def test_hotel_resets_counter(self):
        nodes = [
            {
                "id": "start",
                "name": "Start",
                "type": "place",
                "timezone": "Europe/Vienna",
                "departure_time": "2026-05-01T07:00:00+00:00",
            },
            {
                "id": "hotel",
                "name": "Hotel",
                "type": "hotel",
                "timezone": "Europe/Vienna",
                "duration_minutes": 60,
            },
            {
                "id": "end",
                "name": "End",
                "type": "place",
                "timezone": "Europe/Vienna",
                "duration_minutes": 30,
            },
        ]
        edges = [
            {"from_node_id": "start", "to_node_id": "hotel", "travel_mode": "drive", "travel_time_hours": 9},
            {"from_node_id": "hotel", "to_node_id": "end", "travel_mode": "drive", "travel_time_hours": 7},
        ]
        settings = {"no_drive_window": None, "max_drive_hours_per_day": 10.0}
        enriched = enrich_dag_times(nodes, edges, settings)
        # Hotel should NOT be overnight-held (9 <= 10). End should NOT be held either
        # because hotel reset the counter to 0, and 7 <= 10.
        hotel = _find(enriched, "hotel")
        end = _find(enriched, "end")
        assert hotel["overnight_hold"] is False
        assert end["overnight_hold"] is False

    def test_long_duration_node_resets_counter(self):
        nodes = [
            {
                "id": "start",
                "name": "Start",
                "type": "place",
                "timezone": "Europe/Vienna",
                "departure_time": "2026-05-01T07:00:00+00:00",
            },
            {
                "id": "rest",
                "name": "Beach",
                "type": "activity",
                "timezone": "Europe/Vienna",
                "duration_minutes": 480,
            },
            {
                "id": "end",
                "name": "End",
                "type": "place",
                "timezone": "Europe/Vienna",
                "duration_minutes": 30,
            },
        ]
        edges = [
            {"from_node_id": "start", "to_node_id": "rest", "travel_mode": "drive", "travel_time_hours": 5},
            {"from_node_id": "rest", "to_node_id": "end", "travel_mode": "drive", "travel_time_hours": 5},
        ]
        settings = {"no_drive_window": None, "max_drive_hours_per_day": 10.0}
        enriched = enrich_dag_times(nodes, edges, settings)
        # Without the reset, accumulated would be 10 after rest leg, then 15 > 10 → hold.
        # With the reset (duration 480 >= 360), counter goes to 0 at rest.
        assert _find(enriched, "end")["overnight_hold"] is False


class TestMaxDriveHoursCap:
    def test_cap_triggers_overnight_hold(self):
        nodes = [
            {
                "id": "start",
                "name": "Start",
                "type": "place",
                "timezone": "Europe/Vienna",
                "departure_time": "2026-05-01T06:00:00+00:00",
            },
            {
                "id": "mid",
                "name": "Mid",
                "type": "place",
                "timezone": "Europe/Vienna",
                "duration_minutes": 30,
            },
            {
                "id": "end",
                "name": "End",
                "type": "place",
                "timezone": "Europe/Vienna",
                "duration_minutes": 30,
            },
        ]
        edges = [
            {"from_node_id": "start", "to_node_id": "mid", "travel_mode": "drive", "travel_time_hours": 6},
            {"from_node_id": "mid", "to_node_id": "end", "travel_mode": "drive", "travel_time_hours": 6},
        ]
        settings = {"no_drive_window": None, "max_drive_hours_per_day": 10.0}
        enriched = enrich_dag_times(nodes, edges, settings)
        mid = _find(enriched, "mid")
        # mid accumulates 6h from start leg; its outgoing 6h would push to 12 > 10 → overnight hold.
        assert mid["overnight_hold"] is True
        assert mid["hold_reason"] == "max_drive_hours"


class TestCycleFallback:
    def test_cycle_returns_raw_nodes_with_defaults(self):
        nodes = [
            {"id": "a", "name": "A", "type": "place", "timezone": "UTC"},
            {"id": "b", "name": "B", "type": "place", "timezone": "UTC"},
        ]
        edges = [
            {"from_node_id": "a", "to_node_id": "b", "travel_mode": "drive", "travel_time_hours": 1},
            {"from_node_id": "b", "to_node_id": "a", "travel_mode": "drive", "travel_time_hours": 1},
        ]
        enriched = enrich_dag_times(nodes, edges, {})
        for n in enriched:
            assert n["duration_minutes"] == 30
            assert n["duration_estimated"] is True
            assert n["arrival_time_estimated"] is False
            assert n["departure_time_estimated"] is False
            assert n["timing_conflict"] is None
            assert n["overnight_hold"] is False
