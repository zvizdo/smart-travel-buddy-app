"""Tests for circular route handling in DAG assembler."""


from shared.dag.assembler import _handle_circular_route, assemble_dag


class TestHandleCircularRoute:
    def test_no_change_for_different_names(self):
        locations = [
            {"name": "Paris", "lat": 48.85, "lng": 2.35},
            {"name": "Lyon", "lat": 45.75, "lng": 4.85},
        ]
        result = _handle_circular_route(locations)
        assert result[0]["name"] == "Paris"
        assert result[1]["name"] == "Lyon"

    def test_appends_return_suffix(self):
        locations = [
            {"name": "Denver", "lat": 39.74, "lng": -104.99},
            {"name": "Aspen", "lat": 39.19, "lng": -106.82},
            {"name": "Denver", "lat": 39.74, "lng": -104.99},
        ]
        result = _handle_circular_route(locations)
        assert result[0]["name"] == "Denver"
        assert result[1]["name"] == "Aspen"
        assert result[2]["name"] == "Denver (return)"

    def test_case_insensitive_matching(self):
        locations = [
            {"name": "denver", "lat": 39.74, "lng": -104.99},
            {"name": "Aspen", "lat": 39.19, "lng": -106.82},
            {"name": "Denver", "lat": 39.74, "lng": -104.99},
        ]
        result = _handle_circular_route(locations)
        assert result[2]["name"] == "Denver (return)"

    def test_single_location_unchanged(self):
        locations = [{"name": "Paris", "lat": 48.85, "lng": 2.35}]
        result = _handle_circular_route(locations)
        assert len(result) == 1
        assert result[0]["name"] == "Paris"

    def test_empty_locations_unchanged(self):
        result = _handle_circular_route([])
        assert result == []

    def test_does_not_modify_branch_locations(self):
        locations = [
            {"name": "Denver", "lat": 39.74, "lng": -104.99},
            {"name": "Side Trip", "lat": 40.0, "lng": -105.0, "branch_group": "g1"},
            {"name": "Denver", "lat": 39.74, "lng": -104.99},
        ]
        result = _handle_circular_route(locations)
        # Last spine location renamed
        assert result[2]["name"] == "Denver (return)"
        # Branch location unchanged
        assert result[1]["name"] == "Side Trip"

    def test_does_not_mutate_input(self):
        locations = [
            {"name": "Denver", "lat": 39.74, "lng": -104.99},
            {"name": "Denver", "lat": 39.74, "lng": -104.99},
        ]
        original_name = locations[1]["name"]
        _handle_circular_route(locations)
        assert locations[1]["name"] == original_name


class TestAssembleDagCircular:
    def test_circular_route_produces_distinct_nodes(self):
        locations = [
            {"name": "Denver", "lat": 39.74, "lng": -104.99},
            {"name": "Aspen", "lat": 39.19, "lng": -106.82},
            {"name": "Denver", "lat": 39.74, "lng": -104.99},
        ]
        result = assemble_dag([], locations, "user_1")
        node_names = [n.name for n in result.nodes]
        assert node_names[0] == "Denver"
        assert node_names[2] == "Denver (return)"
        # All node IDs should be unique
        ids = [n.id for n in result.nodes]
        assert len(ids) == len(set(ids))
