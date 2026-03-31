"""Tests for DAG cycle detection and graph traversal utilities."""

from shared.dag.cycle import CycleDetectedError, detect_cycle, get_ancestors, get_descendants


def _edge(from_id: str, to_id: str) -> dict:
    """Helper to create an edge dict."""
    return {"from_node_id": from_id, "to_node_id": to_id}


# ---------------------------------------------------------------------------
# detect_cycle
# ---------------------------------------------------------------------------


class TestDetectCycle:
    """Tests for the detect_cycle function."""

    def test_no_cycle_linear_graph(self):
        """A -> B -> C, add D after C — no cycle."""
        edges = [_edge("A", "B"), _edge("B", "C")]
        result = detect_cycle(edges, "D", incoming_node_ids=["C"], outgoing_node_ids=[])
        assert result is None

    def test_no_cycle_standalone_node(self):
        """Adding a node with no connections never creates a cycle."""
        edges = [_edge("A", "B")]
        result = detect_cycle(edges, "X", incoming_node_ids=[], outgoing_node_ids=[])
        assert result is None

    def test_no_cycle_diamond_graph(self):
        """A -> B, A -> C, both B and C -> D. Add E after D — no cycle."""
        edges = [_edge("A", "B"), _edge("A", "C"), _edge("B", "D"), _edge("C", "D")]
        result = detect_cycle(edges, "E", incoming_node_ids=["D"], outgoing_node_ids=[])
        assert result is None

    def test_no_cycle_diamond_insert(self):
        """Insert node between two converging paths — still acyclic."""
        edges = [_edge("A", "B"), _edge("A", "C"), _edge("B", "D"), _edge("C", "D")]
        # New node X with incoming from B and outgoing to D (replacing B->D conceptually)
        result = detect_cycle(edges, "X", incoming_node_ids=["B"], outgoing_node_ids=["D"])
        assert result is None

    def test_cycle_back_edge(self):
        """A -> B -> C, add D with incoming from C and outgoing to A — creates cycle."""
        edges = [_edge("A", "B"), _edge("B", "C")]
        result = detect_cycle(edges, "D", incoming_node_ids=["C"], outgoing_node_ids=["A"])
        assert result is not None
        assert isinstance(result, list)
        assert len(result) >= 3  # At least A -> ... -> D -> A

    def test_cycle_self_loop(self):
        """A node connecting to itself creates a cycle."""
        edges = []
        result = detect_cycle(edges, "X", incoming_node_ids=["X"], outgoing_node_ids=["X"])
        # X -> X is a self-loop which is a cycle
        assert result is not None

    def test_cycle_through_new_node(self):
        """A -> B -> C. New node D with incoming=[C] outgoing=[A] creates A->B->C->D->A."""
        edges = [_edge("A", "B"), _edge("B", "C")]
        result = detect_cycle(edges, "D", incoming_node_ids=["C"], outgoing_node_ids=["A"])
        assert result is not None
        # The cycle should contain A
        assert "A" in result

    def test_cycle_short_loop(self):
        """A -> B. New node with incoming=[B] outgoing=[A] creates A->B->new->A."""
        edges = [_edge("A", "B")]
        result = detect_cycle(edges, "new", incoming_node_ids=["B"], outgoing_node_ids=["A"])
        assert result is not None

    def test_no_cycle_multiple_incoming_no_outgoing(self):
        """Multiple incoming, no outgoing — can never create a cycle."""
        edges = [_edge("A", "B"), _edge("C", "D")]
        result = detect_cycle(edges, "X", incoming_node_ids=["B", "D"], outgoing_node_ids=[])
        assert result is None

    def test_no_cycle_no_incoming_multiple_outgoing(self):
        """No incoming, multiple outgoing — can never create a cycle."""
        edges = [_edge("A", "B"), _edge("C", "D")]
        result = detect_cycle(edges, "X", incoming_node_ids=[], outgoing_node_ids=["B", "D"])
        assert result is None

    def test_cycle_multi_connection_creates_loop(self):
        """A -> B -> C. New node with incoming=[C] and outgoing=[B] creates B->C->new->B."""
        edges = [_edge("A", "B"), _edge("B", "C")]
        result = detect_cycle(edges, "new", incoming_node_ids=["C"], outgoing_node_ids=["B"])
        assert result is not None

    def test_no_cycle_parallel_paths(self):
        """Two independent paths, new node bridges them without creating cycle."""
        edges = [_edge("A", "B"), _edge("C", "D")]
        # X receives from B, sends to D — no cycle (A->B->X->D, separate from C->D)
        result = detect_cycle(edges, "X", incoming_node_ids=["B"], outgoing_node_ids=["D"])
        assert result is None

    def test_empty_graph_no_cycle(self):
        """Empty graph, adding first node with no connections."""
        result = detect_cycle([], "first", incoming_node_ids=[], outgoing_node_ids=[])
        assert result is None

    def test_large_chain_no_cycle(self):
        """Long chain A0->A1->...->A9, add node at end — no cycle."""
        edges = [_edge(f"A{i}", f"A{i+1}") for i in range(10)]
        result = detect_cycle(edges, "X", incoming_node_ids=["A9"], outgoing_node_ids=[])
        assert result is None

    def test_large_chain_cycle(self):
        """Long chain A0->A1->...->A9, new node from A9 back to A0 — cycle."""
        edges = [_edge(f"A{i}", f"A{i+1}") for i in range(10)]
        result = detect_cycle(edges, "X", incoming_node_ids=["A9"], outgoing_node_ids=["A0"])
        assert result is not None


# ---------------------------------------------------------------------------
# CycleDetectedError
# ---------------------------------------------------------------------------


class TestCycleDetectedError:
    def test_error_message(self):
        err = CycleDetectedError(["A", "B", "C", "A"])
        assert "A -> B -> C -> A" in str(err)
        assert err.cycle_path == ["A", "B", "C", "A"]

    def test_is_exception(self):
        assert issubclass(CycleDetectedError, Exception)


# ---------------------------------------------------------------------------
# get_ancestors
# ---------------------------------------------------------------------------


class TestGetAncestors:
    def test_no_ancestors(self):
        """Root node has no ancestors."""
        edges = [_edge("A", "B"), _edge("B", "C")]
        assert get_ancestors("A", edges) == set()

    def test_direct_parent(self):
        edges = [_edge("A", "B")]
        assert get_ancestors("B", edges) == {"A"}

    def test_transitive_ancestors(self):
        """A -> B -> C: ancestors of C are {A, B}."""
        edges = [_edge("A", "B"), _edge("B", "C")]
        assert get_ancestors("C", edges) == {"A", "B"}

    def test_diamond_ancestors(self):
        """A -> B, A -> C, B -> D, C -> D: ancestors of D are {A, B, C}."""
        edges = [_edge("A", "B"), _edge("A", "C"), _edge("B", "D"), _edge("C", "D")]
        assert get_ancestors("D", edges) == {"A", "B", "C"}

    def test_node_not_in_graph(self):
        """Node not referenced in any edge has no ancestors."""
        edges = [_edge("A", "B")]
        assert get_ancestors("Z", edges) == set()

    def test_does_not_include_self(self):
        edges = [_edge("A", "B"), _edge("B", "C")]
        ancestors = get_ancestors("C", edges)
        assert "C" not in ancestors

    def test_multiple_roots(self):
        """X -> C, Y -> C: ancestors of C are {X, Y}."""
        edges = [_edge("X", "C"), _edge("Y", "C")]
        assert get_ancestors("C", edges) == {"X", "Y"}


# ---------------------------------------------------------------------------
# get_descendants
# ---------------------------------------------------------------------------


class TestGetDescendants:
    def test_no_descendants(self):
        """Leaf node has no descendants."""
        edges = [_edge("A", "B"), _edge("B", "C")]
        assert get_descendants("C", edges) == set()

    def test_direct_child(self):
        edges = [_edge("A", "B")]
        assert get_descendants("A", edges) == {"B"}

    def test_transitive_descendants(self):
        """A -> B -> C: descendants of A are {B, C}."""
        edges = [_edge("A", "B"), _edge("B", "C")]
        assert get_descendants("A", edges) == {"B", "C"}

    def test_diamond_descendants(self):
        """A -> B, A -> C, B -> D, C -> D: descendants of A are {B, C, D}."""
        edges = [_edge("A", "B"), _edge("A", "C"), _edge("B", "D"), _edge("C", "D")]
        assert get_descendants("A", edges) == {"B", "C", "D"}

    def test_node_not_in_graph(self):
        edges = [_edge("A", "B")]
        assert get_descendants("Z", edges) == set()

    def test_does_not_include_self(self):
        edges = [_edge("A", "B"), _edge("B", "C")]
        descendants = get_descendants("A", edges)
        assert "A" not in descendants

    def test_branching_descendants(self):
        """A -> B, A -> C: descendants of A are {B, C}."""
        edges = [_edge("A", "B"), _edge("A", "C")]
        assert get_descendants("A", edges) == {"B", "C"}
