"""Tests for compute_cascade, especially merge-node (in-degree > 1) behaviour."""

from datetime import UTC, datetime, timedelta

from shared.dag.cascade import compute_cascade, parse_dt


def _node(
    node_id: str,
    arrival: str | None = None,
    departure: str | None = None,
    name: str | None = None,
) -> dict:
    return {
        "id": node_id,
        "name": name or node_id,
        "arrival_time": arrival,
        "departure_time": departure,
    }


def _edge(from_id: str, to_id: str, travel_hours: float) -> dict:
    return {
        "from_node_id": from_id,
        "to_node_id": to_id,
        "travel_time_hours": travel_hours,
    }


class TestComputeCascade:
    def test_linear_chain_cascades_forward(self):
        """A -> B -> C: shifting A's departure shifts B and C."""
        a_depart = datetime(2026, 5, 1, 10, 0, tzinfo=UTC)
        nodes = [
            _node("A", arrival="2026-05-01T09:00:00+00:00", departure="2026-05-01T10:00:00+00:00"),
            _node("B", arrival="2026-05-01T12:00:00+00:00", departure="2026-05-01T14:00:00+00:00"),
            _node("C", arrival="2026-05-01T16:00:00+00:00"),
        ]
        edges = [_edge("A", "B", 2), _edge("B", "C", 2)]

        new_a_depart = a_depart + timedelta(hours=3)  # 13:00
        result = compute_cascade("A", new_a_depart, nodes, edges)

        affected = {a["id"]: a for a in result["affected_nodes"]}
        assert set(affected.keys()) == {"B", "C"}
        # B arrives 15:00 (13 + 2), keeps its 2h stay so departs 17:00
        assert parse_dt(affected["B"]["new_arrival"]) == datetime(2026, 5, 1, 15, 0, tzinfo=UTC)
        assert parse_dt(affected["B"]["new_departure"]) == datetime(2026, 5, 1, 17, 0, tzinfo=UTC)
        # C arrives 19:00 (17 + 2)
        assert parse_dt(affected["C"]["new_arrival"]) == datetime(2026, 5, 1, 19, 0, tzinfo=UTC)

    def test_merge_node_takes_latest_parent_arrival(self):
        """Diamond DAG: A -> B -> D and A -> C -> D with asymmetric travel times.
        D must wait for whichever parent arrives last.

        A departs 10:00.
        A -> B is 1h, B stays 0h, B -> D is 1h   → D via B ready at 12:00
        A -> C is 1h, C stays 0h, C -> D is 5h   → D via C ready at 16:00
        D should arrive at 16:00 (max of the two), NOT 12:00.
        """
        a_depart = datetime(2026, 5, 1, 10, 0, tzinfo=UTC)
        nodes = [
            _node("A", arrival="2026-05-01T09:00:00+00:00", departure="2026-05-01T10:00:00+00:00"),
            _node("B", arrival="2026-05-01T11:00:00+00:00", departure="2026-05-01T11:00:00+00:00"),
            _node("C", arrival="2026-05-01T11:00:00+00:00", departure="2026-05-01T11:00:00+00:00"),
            _node("D", arrival="2026-05-01T16:00:00+00:00"),
        ]
        edges = [
            _edge("A", "B", 1),
            _edge("A", "C", 1),
            _edge("B", "D", 1),
            _edge("C", "D", 5),
        ]

        result = compute_cascade("A", a_depart, nodes, edges)
        affected = {a["id"]: a for a in result["affected_nodes"]}

        # D's original arrival (16:00) already matches the "via C" path, so
        # the assertion is about what D's new_arrival would be if we shifted
        # A. Let's shift by 1 hour and check that D takes max.
        a_shifted = a_depart + timedelta(hours=1)  # 11:00
        # via B: 11 + 1 + 0 + 1 = 13:00; via C: 11 + 1 + 0 + 5 = 17:00 → D = 17:00
        result_shifted = compute_cascade("A", a_shifted, nodes, edges)
        affected_shifted = {a["id"]: a for a in result_shifted["affected_nodes"]}
        assert "D" in affected_shifted
        assert parse_dt(affected_shifted["D"]["new_arrival"]) == datetime(
            2026, 5, 1, 17, 0, tzinfo=UTC
        )
        # Also check we didn't accidentally use the "via B" time (13:00).
        assert parse_dt(affected_shifted["D"]["new_arrival"]) != datetime(
            2026, 5, 1, 13, 0, tzinfo=UTC
        )

    def test_merge_node_old_behaviour_would_be_wrong(self):
        """Sanity: same topology, make B -> D the slow edge and C -> D the fast one.

        A last-writer-wins BFS would set D = latest *queued* parent, which
        depends on iteration order over A's out-edges — fragile. The fix
        holds D back until every parent is resolved and uses max().
        """
        a_depart = datetime(2026, 5, 1, 10, 0, tzinfo=UTC)
        nodes = [
            _node("A", arrival="2026-05-01T09:00:00+00:00", departure="2026-05-01T10:00:00+00:00"),
            _node("B", arrival="2026-05-01T11:00:00+00:00", departure="2026-05-01T11:00:00+00:00"),
            _node("C", arrival="2026-05-01T11:00:00+00:00", departure="2026-05-01T11:00:00+00:00"),
            _node("D"),
        ]
        edges = [
            _edge("A", "B", 1),
            _edge("A", "C", 1),
            _edge("B", "D", 10),  # via B is now slow
            _edge("C", "D", 2),   # via C is now fast
        ]

        result = compute_cascade("A", a_depart, nodes, edges)
        affected = {a["id"]: a for a in result["affected_nodes"]}

        # via B: 10 + 1 + 0 + 10 = 21:00; via C: 10 + 1 + 0 + 2 = 13:00 → D = 21:00
        assert parse_dt(affected["D"]["new_arrival"]) == datetime(
            2026, 5, 1, 21, 0, tzinfo=UTC
        )

    def test_no_downstream_returns_empty(self):
        """Modifying a leaf node produces no cascade."""
        nodes = [
            _node("A", arrival="2026-05-01T09:00:00+00:00", departure="2026-05-01T10:00:00+00:00"),
        ]
        result = compute_cascade(
            "A", datetime(2026, 5, 1, 10, 0, tzinfo=UTC), nodes, []
        )
        assert result == {"affected_nodes": [], "conflicts": []}

    def test_small_change_below_threshold_is_skipped(self):
        """A change under 60 seconds should not mark B as affected."""
        nodes = [
            _node("A", arrival="2026-05-01T09:00:00+00:00", departure="2026-05-01T10:00:00+00:00"),
            _node("B", arrival="2026-05-01T11:00:00+00:00"),
        ]
        edges = [_edge("A", "B", 1)]
        # Shift A's departure by 30s — B's recomputed arrival differs by 30s.
        new_depart = datetime(2026, 5, 1, 10, 0, 30, tzinfo=UTC)
        result = compute_cascade("A", new_depart, nodes, edges)
        assert result["affected_nodes"] == []
