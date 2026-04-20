"""Tests for the shared trip-context markdown formatter.

Covers the rendering of enriched fields that downstream consumers (in-app
Gemini agent, MCP ``get_trip_context`` tool) rely on. Enrichment itself is
covered by ``test_time_inference.py``; this file focuses on the
``format_trip_context`` output shape.
"""

from shared.tools.trip_context import build_agent_trip_context


class TestPerBranchArrivalsBlock:
    """A merge node with divergent parent arrivals should render a
    ``🔀 per-branch arrivals:`` block listing each branch by the
    source node's name, with a ``~`` prefix on each branch time."""

    def test_merge_node_emits_per_branch_block(self):
        nodes = [
            {
                "id": "n_a",
                "name": "Origin A",
                "type": "place",
                "timezone": "UTC",
                "departure_time": "2026-05-01T09:00:00+00:00",
            },
            {
                "id": "n_b",
                "name": "Origin B",
                "type": "place",
                "timezone": "UTC",
                "departure_time": "2026-05-01T12:00:00+00:00",
            },
            {
                "id": "n_c",
                "name": "Meeting Point",
                "type": "place",
                "timezone": "UTC",
            },
        ]
        edges = [
            {
                "from_node_id": "n_a",
                "to_node_id": "n_c",
                "travel_mode": "drive",
                "travel_time_hours": 1,
            },
            {
                "from_node_id": "n_b",
                "to_node_id": "n_c",
                "travel_mode": "drive",
                "travel_time_hours": 1,
            },
        ]

        out = build_agent_trip_context(nodes, edges, {})

        assert "🔀 per-branch arrivals:" in out
        # Source-node names surfaced (not raw edge_ids / node ids).
        assert "via Origin A" in out
        assert "via Origin B" in out
        # Each branch time is flagged as estimated with the ``~`` prefix.
        assert out.count("via Origin") == 2
        for line in out.splitlines():
            if line.strip().startswith("via Origin"):
                assert "~" in line, f"branch line missing ~ prefix: {line!r}"

    def test_linear_trip_omits_per_branch_block(self):
        # Single-parent / linear nodes never carry per_parent_arrivals, so
        # the block must not appear.
        nodes = [
            {
                "id": "n_a",
                "name": "Start",
                "type": "place",
                "timezone": "UTC",
                "departure_time": "2026-05-01T09:00:00+00:00",
            },
            {
                "id": "n_b",
                "name": "End",
                "type": "place",
                "timezone": "UTC",
            },
        ]
        edges = [
            {
                "from_node_id": "n_a",
                "to_node_id": "n_b",
                "travel_mode": "drive",
                "travel_time_hours": 1,
            }
        ]
        out = build_agent_trip_context(nodes, edges, {})
        assert "🔀" not in out
        assert "per-branch arrivals" not in out

    def test_within_tolerance_merge_omits_per_branch_block(self):
        # Parents arrive within _CONFLICT_TOLERANCE_SECONDS → enrichment
        # suppresses per_parent_arrivals → formatter renders nothing.
        nodes = [
            {
                "id": "n_a",
                "name": "Origin A",
                "type": "place",
                "timezone": "UTC",
                "departure_time": "2026-05-01T11:59:31+00:00",
            },
            {
                "id": "n_b",
                "name": "Origin B",
                "type": "place",
                "timezone": "UTC",
                "departure_time": "2026-05-01T12:00:00+00:00",
            },
            {"id": "n_c", "name": "Merge", "type": "place", "timezone": "UTC"},
        ]
        edges = [
            {
                "from_node_id": "n_a",
                "to_node_id": "n_c",
                "travel_mode": "drive",
                "travel_time_hours": 1,
            },
            {
                "from_node_id": "n_b",
                "to_node_id": "n_c",
                "travel_mode": "drive",
                "travel_time_hours": 1,
            },
        ]
        out = build_agent_trip_context(nodes, edges, {})
        assert "🔀" not in out

    def test_edge_id_key_resolves_to_from_node_name(self):
        # When edges carry explicit IDs, per_parent_arrivals keys by the
        # edge id. The formatter must still resolve the source node name.
        nodes = [
            {
                "id": "n_a",
                "name": "Origin A",
                "type": "place",
                "timezone": "UTC",
                "departure_time": "2026-05-01T09:00:00+00:00",
            },
            {
                "id": "n_b",
                "name": "Origin B",
                "type": "place",
                "timezone": "UTC",
                "departure_time": "2026-05-01T12:00:00+00:00",
            },
            {"id": "n_c", "name": "Merge", "type": "place", "timezone": "UTC"},
        ]
        edges = [
            {
                "id": "e_xyz",
                "from_node_id": "n_a",
                "to_node_id": "n_c",
                "travel_mode": "drive",
                "travel_time_hours": 1,
            },
            {
                "id": "e_abc",
                "from_node_id": "n_b",
                "to_node_id": "n_c",
                "travel_mode": "drive",
                "travel_time_hours": 1,
            },
        ]
        out = build_agent_trip_context(nodes, edges, {})
        assert "via Origin A" in out
        assert "via Origin B" in out
        # Raw edge IDs should never leak into the markdown.
        assert "via e_xyz" not in out
        assert "via e_abc" not in out
