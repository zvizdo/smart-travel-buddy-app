"""Tests for participant path computation, divergence, and merge detection."""

import pytest

from shared.dag.paths import (
    DivergencePoint,
    MergeNode,
    PathResult,
    build_adjacency,
    compute_participant_paths,
    detect_divergence_points,
    detect_merge_nodes,
    detect_unresolved_flows,
    find_root_nodes,
)


# ── Helpers ──────────────────────────────────────────────────────
def _node(id: str, participant_ids: list[str] | None = None) -> dict:
    return {"id": id, "name": id, "participant_ids": participant_ids}


def _edge(from_id: str, to_id: str) -> dict:
    return {"from_node_id": from_id, "to_node_id": to_id}


# ── Adjacency & Root Detection ──────────────────────────────────
class TestBuildAdjacency:
    def test_empty(self):
        fwd, rev = build_adjacency([])
        assert fwd == {}
        assert rev == {}

    def test_linear(self):
        edges = [_edge("A", "B"), _edge("B", "C")]
        fwd, rev = build_adjacency(edges)
        assert fwd == {"A": ["B"], "B": ["C"]}
        assert rev == {"B": ["A"], "C": ["B"]}

    def test_divergence(self):
        edges = [_edge("A", "B"), _edge("A", "C")]
        fwd, _ = build_adjacency(edges)
        assert set(fwd["A"]) == {"B", "C"}


class TestFindRootNodes:
    def test_single_root(self):
        nodes = [_node("A"), _node("B"), _node("C")]
        _, rev = build_adjacency([_edge("A", "B"), _edge("B", "C")])
        roots = find_root_nodes(nodes, rev)
        assert roots == ["A"]

    def test_multiple_roots(self):
        nodes = [_node("A"), _node("B"), _node("C")]
        _, rev = build_adjacency([_edge("A", "C"), _edge("B", "C")])
        roots = find_root_nodes(nodes, rev)
        assert set(roots) == {"A", "B"}

    def test_no_edges_all_roots(self):
        nodes = [_node("A"), _node("B")]
        roots = find_root_nodes(nodes, {})
        assert set(roots) == {"A", "B"}


# ── Linear DAG Path Computation ─────────────────────────────────
class TestLinearPaths:
    def test_single_participant_linear(self):
        nodes = [_node("A"), _node("B"), _node("C")]
        edges = [_edge("A", "B"), _edge("B", "C")]
        result = compute_participant_paths(nodes, edges, ["user_1"])
        assert result.paths["user_1"] == ["A", "B", "C"]
        assert result.unresolved == []

    def test_multiple_participants_same_linear_path(self):
        nodes = [_node("A"), _node("B")]
        edges = [_edge("A", "B")]
        result = compute_participant_paths(nodes, edges, ["u1", "u2"])
        assert result.paths["u1"] == ["A", "B"]
        assert result.paths["u2"] == ["A", "B"]

    def test_single_node_no_edges(self):
        nodes = [_node("A")]
        result = compute_participant_paths(nodes, [], ["u1"])
        assert result.paths["u1"] == ["A"]

    def test_no_nodes(self):
        result = compute_participant_paths([], [], ["u1"])
        assert result.paths["u1"] == []


# ── Divergence / Branching ───────────────────────────────────────
class TestDivergentPaths:
    """DAG with a split:  A -> B (user_1), A -> C (user_2), B -> D, C -> D"""

    @pytest.fixture()
    def divergent_dag(self):
        nodes = [
            _node("A"),
            _node("B", participant_ids=["u1"]),
            _node("C", participant_ids=["u2"]),
            _node("D"),
        ]
        edges = [_edge("A", "B"), _edge("A", "C"), _edge("B", "D"), _edge("C", "D")]
        return nodes, edges

    def test_user1_follows_assigned_branch(self, divergent_dag):
        nodes, edges = divergent_dag
        result = compute_participant_paths(nodes, edges, ["u1"])
        assert result.paths["u1"] == ["A", "B", "D"]

    def test_user2_follows_assigned_branch(self, divergent_dag):
        nodes, edges = divergent_dag
        result = compute_participant_paths(nodes, edges, ["u2"])
        assert result.paths["u2"] == ["A", "C", "D"]

    def test_both_users_diverge_and_merge(self, divergent_dag):
        nodes, edges = divergent_dag
        result = compute_participant_paths(nodes, edges, ["u1", "u2"])
        assert result.paths["u1"] == ["A", "B", "D"]
        assert result.paths["u2"] == ["A", "C", "D"]
        assert result.unresolved == []

    def test_unresolved_at_divergence(self):
        """User u3 is not assigned at the divergence point."""
        nodes = [
            _node("A"),
            _node("B", participant_ids=["u1"]),
            _node("C", participant_ids=["u2"]),
        ]
        edges = [_edge("A", "B"), _edge("A", "C")]
        result = compute_participant_paths(nodes, edges, ["u3"])
        # u3 should have an unresolved warning
        assert len(result.unresolved) == 1
        assert result.unresolved[0]["user_id"] == "u3"
        assert result.unresolved[0]["divergence_node_id"] == "A"

    def test_unresolved_when_no_children_assigned(self):
        """Divergence where no child has participant_ids — everyone is unresolved."""
        nodes = [_node("A"), _node("B"), _node("C")]
        edges = [_edge("A", "B"), _edge("A", "C")]
        result = compute_participant_paths(nodes, edges, ["u1", "u2"])
        assert len(result.unresolved) == 2
        assert all(w["divergence_node_id"] == "A" for w in result.unresolved)
        assert {w["user_id"] for w in result.unresolved} == {"u1", "u2"}
        # Participants should stop at A (not flow down both branches)
        assert result.paths["u1"] == ["A"]
        assert result.paths["u2"] == ["A"]

    def test_mixed_assigned_and_shared_branches(self):
        """One branch assigned, one shared — unassigned user follows shared."""
        nodes = [
            _node("A"),
            _node("B", participant_ids=["u1"]),
            _node("C"),  # shared
            _node("D"),
        ]
        edges = [_edge("A", "B"), _edge("A", "C"), _edge("C", "D")]
        result = compute_participant_paths(nodes, edges, ["u1", "u2"])
        assert result.paths["u1"] == ["A", "B"]
        assert result.paths["u2"] == ["A", "C", "D"]
        assert result.unresolved == []


class TestMultipleRoots:
    """DAG with two or more start points (root nodes with in-degree 0)."""

    def test_assigned_roots_each_user_follows_own(self):
        """Two roots, each assigned — users follow their assigned root."""
        nodes = [
            _node("A", participant_ids=["u1"]),
            _node("B", participant_ids=["u2"]),
            _node("C"),
        ]
        edges = [_edge("A", "C"), _edge("B", "C")]
        result = compute_participant_paths(nodes, edges, ["u1", "u2"])
        assert result.paths["u1"] == ["A", "C"]
        assert result.paths["u2"] == ["B", "C"]
        assert result.unresolved == []

    def test_unassigned_roots_all_unresolved(self):
        """Two roots with no assignments — everyone unresolved at __root__."""
        nodes = [_node("A"), _node("B"), _node("C")]
        edges = [_edge("A", "C"), _edge("B", "C")]
        result = compute_participant_paths(nodes, edges, ["u1", "u2"])
        root_warnings = [w for w in result.unresolved if w["divergence_node_id"] == "__root__"]
        assert len(root_warnings) == 2
        assert {w["user_id"] for w in root_warnings} == {"u1", "u2"}

    def test_mixed_assigned_and_unassigned_roots(self):
        """One root assigned, one unassigned — unassigned user falls back without warning."""
        nodes = [
            _node("A", participant_ids=["u1"]),
            _node("B"),  # unassigned root
            _node("C"),
        ]
        edges = [_edge("A", "C"), _edge("B", "C")]
        result = compute_participant_paths(nodes, edges, ["u1", "u2"])
        assert result.paths["u1"] == ["A", "C"]
        # u2 falls back to unassigned root B
        assert result.paths["u2"] == ["B", "C"]
        # No __root__ warning because B is an unassigned fallback
        root_warnings = [w for w in result.unresolved if w["divergence_node_id"] == "__root__"]
        assert root_warnings == []

    def test_all_roots_assigned_user_not_on_any(self):
        """All roots assigned but u3 isn't on any — unresolved at __root__."""
        nodes = [
            _node("A", participant_ids=["u1"]),
            _node("B", participant_ids=["u2"]),
            _node("C"),
        ]
        edges = [_edge("A", "C"), _edge("B", "C")]
        result = compute_participant_paths(nodes, edges, ["u1", "u2", "u3"])
        assert result.paths["u1"] == ["A", "C"]
        assert result.paths["u2"] == ["B", "C"]
        u3_root = [
            w for w in result.unresolved
            if w["user_id"] == "u3" and w["divergence_node_id"] == "__root__"
        ]
        assert len(u3_root) == 1

    def test_three_roots(self):
        """Three starting points converging at a single merge node."""
        nodes = [
            _node("A", participant_ids=["u1"]),
            _node("B", participant_ids=["u2"]),
            _node("C", participant_ids=["u3"]),
            _node("D"),
        ]
        edges = [_edge("A", "D"), _edge("B", "D"), _edge("C", "D")]
        result = compute_participant_paths(nodes, edges, ["u1", "u2", "u3"])
        assert result.paths["u1"] == ["A", "D"]
        assert result.paths["u2"] == ["B", "D"]
        assert result.paths["u3"] == ["C", "D"]
        assert result.unresolved == []

    def test_multi_root_plus_downstream_divergence(self):
        """Two roots + a downstream divergence. Both divergence layers work."""
        # A(u1) -> C -> D(u1), B(u2) -> C -> E(u2)
        nodes = [
            _node("A", participant_ids=["u1"]),
            _node("B", participant_ids=["u2"]),
            _node("C"),
            _node("D", participant_ids=["u1"]),
            _node("E", participant_ids=["u2"]),
        ]
        edges = [_edge("A", "C"), _edge("B", "C"), _edge("C", "D"), _edge("C", "E")]
        result = compute_participant_paths(nodes, edges, ["u1", "u2"])
        assert result.paths["u1"] == ["A", "C", "D"]
        assert result.paths["u2"] == ["B", "C", "E"]
        assert result.unresolved == []

    def test_multi_root_independent_chains(self):
        """Two roots leading to separate chains, no merge."""
        nodes = [
            _node("A", participant_ids=["u1"]),
            _node("B", participant_ids=["u2"]),
            _node("C"),
            _node("D"),
        ]
        edges = [_edge("A", "C"), _edge("B", "D")]
        result = compute_participant_paths(nodes, edges, ["u1", "u2"])
        assert result.paths["u1"] == ["A", "C"]
        assert result.paths["u2"] == ["B", "D"]
        assert result.unresolved == []


# ── Divergence Detection ─────────────────────────────────────────
class TestDivergenceDetection:
    def test_no_divergence_in_linear_dag(self):
        nodes = [_node("A"), _node("B"), _node("C")]
        edges = [_edge("A", "B"), _edge("B", "C")]
        divs = detect_divergence_points(nodes, edges)
        assert divs == []

    def test_detects_divergence(self):
        nodes = [_node("A"), _node("B"), _node("C")]
        edges = [_edge("A", "B"), _edge("A", "C")]
        divs = detect_divergence_points(nodes, edges)
        assert len(divs) == 1
        assert divs[0].node_id == "A"
        assert set(divs[0].child_node_ids) == {"B", "C"}

    def test_multiple_divergences(self):
        nodes = [_node("A"), _node("B"), _node("C"), _node("D"), _node("E")]
        edges = [_edge("A", "B"), _edge("A", "C"), _edge("C", "D"), _edge("C", "E")]
        divs = detect_divergence_points(nodes, edges)
        div_ids = {d.node_id for d in divs}
        assert div_ids == {"A", "C"}

    def test_multi_root_creates_virtual_divergence(self):
        """Two root nodes produce a __root__ divergence."""
        nodes = [_node("A"), _node("B"), _node("C")]
        edges = [_edge("A", "C"), _edge("B", "C")]
        divs = detect_divergence_points(nodes, edges)
        root_divs = [d for d in divs if d.node_id == "__root__"]
        assert len(root_divs) == 1
        assert set(root_divs[0].child_node_ids) == {"A", "B"}

    def test_single_root_no_virtual_divergence(self):
        """A single root should NOT produce a __root__ divergence."""
        nodes = [_node("A"), _node("B"), _node("C")]
        edges = [_edge("A", "B"), _edge("A", "C")]
        divs = detect_divergence_points(nodes, edges)
        root_divs = [d for d in divs if d.node_id == "__root__"]
        assert root_divs == []

    def test_three_roots_virtual_divergence(self):
        """Three root nodes produce a single __root__ divergence with all three."""
        nodes = [_node("A"), _node("B"), _node("C"), _node("D")]
        edges = [_edge("A", "D"), _edge("B", "D"), _edge("C", "D")]
        divs = detect_divergence_points(nodes, edges)
        root_divs = [d for d in divs if d.node_id == "__root__"]
        assert len(root_divs) == 1
        assert set(root_divs[0].child_node_ids) == {"A", "B", "C"}

    def test_multi_root_plus_downstream_divergence_detection(self):
        """__root__ divergence coexists with a downstream divergence."""
        nodes = [_node("A"), _node("B"), _node("C"), _node("D"), _node("E")]
        edges = [_edge("A", "C"), _edge("B", "C"), _edge("C", "D"), _edge("C", "E")]
        divs = detect_divergence_points(nodes, edges)
        div_ids = {d.node_id for d in divs}
        assert div_ids == {"__root__", "C"}


# ── Merge Detection ──────────────────────────────────────────────
class TestMergeDetection:
    def test_no_merge_in_linear_dag(self):
        nodes = [_node("A"), _node("B"), _node("C")]
        edges = [_edge("A", "B"), _edge("B", "C")]
        merges = detect_merge_nodes(nodes, edges)
        assert merges == []

    def test_detects_merge(self):
        nodes = [_node("A"), _node("B"), _node("C")]
        edges = [_edge("A", "C"), _edge("B", "C")]
        merges = detect_merge_nodes(nodes, edges)
        assert len(merges) == 1
        assert merges[0].node_id == "C"

    def test_diamond_has_merge(self):
        """A -> B, A -> C, B -> D, C -> D: D is merge node."""
        nodes = [_node("A"), _node("B"), _node("C"), _node("D")]
        edges = [_edge("A", "B"), _edge("A", "C"), _edge("B", "D"), _edge("C", "D")]
        merges = detect_merge_nodes(nodes, edges)
        assert len(merges) == 1
        assert merges[0].node_id == "D"


# ── Unresolved Flow Detection ────────────────────────────────────
class TestUnresolvedFlows:
    def test_no_warnings_in_linear_dag(self):
        nodes = [_node("A"), _node("B")]
        edges = [_edge("A", "B")]
        warnings = detect_unresolved_flows(nodes, edges, ["u1"])
        assert warnings == []

    def test_no_warnings_when_all_assigned(self):
        nodes = [
            _node("A"),
            _node("B", participant_ids=["u1"]),
            _node("C", participant_ids=["u2"]),
        ]
        edges = [_edge("A", "B"), _edge("A", "C")]
        warnings = detect_unresolved_flows(nodes, edges, ["u1", "u2"])
        assert warnings == []

    def test_warns_unassigned_participant(self):
        nodes = [
            _node("A"),
            _node("B", participant_ids=["u1"]),
            _node("C", participant_ids=["u2"]),
        ]
        edges = [_edge("A", "B"), _edge("A", "C")]
        warnings = detect_unresolved_flows(nodes, edges, ["u1", "u2", "u3"])
        u3_warnings = [w for w in warnings if w["user_id"] == "u3"]
        assert len(u3_warnings) == 1
        assert u3_warnings[0]["divergence_node_id"] == "A"

    def test_no_warning_when_child_unassigned(self):
        """If a divergence child has no participant_ids (shared), everyone can pass."""
        nodes = [
            _node("A"),
            _node("B"),  # no participant_ids = shared
            _node("C", participant_ids=["u1"]),
        ]
        edges = [_edge("A", "B"), _edge("A", "C")]
        warnings = detect_unresolved_flows(nodes, edges, ["u2"])
        # u2 can go through B (shared), so no warning
        assert warnings == []

    def test_warns_all_when_no_children_assigned(self):
        """Divergence where no child has participant_ids — all participants warned."""
        nodes = [_node("A"), _node("B"), _node("C")]
        edges = [_edge("A", "B"), _edge("A", "C")]
        warnings = detect_unresolved_flows(nodes, edges, ["u1", "u2"])
        assert len(warnings) == 2
        assert {w["user_id"] for w in warnings} == {"u1", "u2"}

    def test_multi_root_unassigned_warns_all(self):
        """Two unassigned roots — all participants warned at __root__."""
        nodes = [_node("A"), _node("B"), _node("C")]
        edges = [_edge("A", "C"), _edge("B", "C")]
        warnings = detect_unresolved_flows(nodes, edges, ["u1", "u2"])
        root_warnings = [w for w in warnings if w["divergence_node_id"] == "__root__"]
        assert len(root_warnings) == 2
        assert {w["user_id"] for w in root_warnings} == {"u1", "u2"}

    def test_multi_root_assigned_no_warnings(self):
        """Two roots with each user assigned — no __root__ warnings."""
        nodes = [
            _node("A", participant_ids=["u1"]),
            _node("B", participant_ids=["u2"]),
            _node("C"),
        ]
        edges = [_edge("A", "C"), _edge("B", "C")]
        warnings = detect_unresolved_flows(nodes, edges, ["u1", "u2"])
        root_warnings = [w for w in warnings if w["divergence_node_id"] == "__root__"]
        assert root_warnings == []

    def test_multi_root_unassigned_user_with_shared_fallback(self):
        """One root assigned, one unassigned — unassigned serves as fallback, no warning."""
        nodes = [
            _node("A", participant_ids=["u1"]),
            _node("B"),  # shared fallback
            _node("C"),
        ]
        edges = [_edge("A", "C"), _edge("B", "C")]
        warnings = detect_unresolved_flows(nodes, edges, ["u1", "u2"])
        root_warnings = [w for w in warnings if w["divergence_node_id"] == "__root__"]
        assert root_warnings == []

    def test_multi_root_all_assigned_missing_user(self):
        """All roots assigned but u3 is not on any — u3 warned at __root__."""
        nodes = [
            _node("A", participant_ids=["u1"]),
            _node("B", participant_ids=["u2"]),
            _node("C"),
        ]
        edges = [_edge("A", "C"), _edge("B", "C")]
        warnings = detect_unresolved_flows(nodes, edges, ["u1", "u2", "u3"])
        u3_root = [
            w for w in warnings
            if w["user_id"] == "u3" and w["divergence_node_id"] == "__root__"
        ]
        assert len(u3_root) == 1
