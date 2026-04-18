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


class TestTimingConflictSeverity:
    """Direct, readable coverage of the severity-banding thresholds.

    Parity with the TS mirror is enforced by the shared JSON fixture; these
    tests exist so a reader of this file can see the decision table without
    cross-referencing the fixture.
    """

    @staticmethod
    def _case(user_arrival: str, travel_hours: float = 1) -> dict:
        nodes = [
            {
                "id": "a",
                "name": "A",
                "type": "place",
                "timezone": "UTC",
                "departure_time": "2026-05-01T09:00:00+00:00",
            },
            {
                "id": "b",
                "name": "B",
                "type": "activity",
                "timezone": "UTC",
                "arrival_time": user_arrival,
                "departure_time": "2026-05-01T13:00:00+00:00",
            },
        ]
        edges = [
            {
                "from_node_id": "a",
                "to_node_id": "b",
                "travel_mode": "drive",
                "travel_time_hours": travel_hours,
            }
        ]
        enriched = enrich_dag_times(nodes, edges, {})
        return _find(enriched, "b")

    def test_early_under_threshold_is_suppressed(self):
        # Propagated 10:00, user 10:10 → 10 min early → below the 30-min floor
        b = self._case("2026-05-01T10:10:00+00:00")
        assert b["timing_conflict"] is None
        assert b["timing_conflict_severity"] is None

    def test_early_29m59s_is_still_suppressed(self):
        b = self._case("2026-05-01T10:29:59+00:00")
        assert b["timing_conflict"] is None
        assert b["timing_conflict_severity"] is None

    def test_early_exactly_30m_crosses_into_info(self):
        b = self._case("2026-05-01T10:30:00+00:00")
        assert b["timing_conflict_severity"] == "info"
        assert b["timing_conflict"] is not None

    def test_early_in_info_band(self):
        # 45 min early
        b = self._case("2026-05-01T10:45:00+00:00")
        assert b["timing_conflict_severity"] == "info"

    def test_early_just_under_2h_stays_info(self):
        # 1h59m early
        b = self._case("2026-05-01T11:59:00+00:00")
        assert b["timing_conflict_severity"] == "info"

    def test_early_exactly_2h_crosses_into_advisory(self):
        b = self._case("2026-05-01T12:00:00+00:00")
        assert b["timing_conflict_severity"] == "advisory"

    def test_early_well_over_2h_is_advisory(self):
        # 3h early — clearly unintentional buffer
        b = self._case("2026-05-01T13:00:00+00:00", travel_hours=1)
        assert b["timing_conflict_severity"] == "advisory"

    def test_late_by_2_minutes_is_error(self):
        # Propagated 10:00, user 09:58 → 2 min late
        b = self._case("2026-05-01T09:58:00+00:00")
        assert b["timing_conflict_severity"] == "error"

    def test_late_by_30_minutes_is_error(self):
        b = self._case("2026-05-01T09:30:00+00:00")
        assert b["timing_conflict_severity"] == "error"

    def test_within_tolerance_is_null(self):
        # 30 seconds — below the 60s noise floor for both directions
        b = self._case("2026-05-01T10:00:30+00:00")
        assert b["timing_conflict"] is None
        assert b["timing_conflict_severity"] is None

    def test_severity_paired_with_message_when_emitted(self):
        # Wherever a conflict message is set, severity must also be set,
        # and vice versa. Covers the invariant the UI relies on.
        for user_arrival in (
            "2026-05-01T10:30:00+00:00",  # info
            "2026-05-01T12:00:00+00:00",  # advisory
            "2026-05-01T09:30:00+00:00",  # error
        ):
            b = self._case(user_arrival)
            assert (b["timing_conflict"] is None) == (
                b["timing_conflict_severity"] is None
            ), f"desync at {user_arrival}: {b['timing_conflict']=} {b['timing_conflict_severity']=}"


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
        assert hotel["drive_cap_warning"] is False
        assert end["drive_cap_warning"] is False

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
        assert _find(enriched, "end")["drive_cap_warning"] is False


class TestMaxDriveHoursCap:
    def test_cap_triggers_passive_warning(self):
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
        end = _find(enriched, "end")
        # mid accumulates 6h from start leg; its outgoing 6h would push to 12 > 10 → passive warning on end.
        assert mid["drive_cap_warning"] is False
        assert end.get("drive_cap_warning") is True
        assert end["hold_reason"] == "max_drive_hours"


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
