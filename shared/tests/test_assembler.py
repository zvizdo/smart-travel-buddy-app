"""Tests for DAG assembly logic."""

from datetime import UTC, datetime, timedelta

from shared.dag.assembler import assemble_dag


class TestAssembleDag:
    """Tests for the assemble_dag function."""

    def test_empty_locations_returns_empty_result(self):
        result = assemble_dag(notes=[], geocoded_locations=[], created_by="user_1")
        assert result.nodes == []
        assert result.edges == []

    def test_single_location_produces_one_node_no_edges(self):
        locations = [
            {"name": "Paris", "lat": 48.8566, "lng": 2.3522, "duration_hours": 48}
        ]
        result = assemble_dag(notes=[], geocoded_locations=locations, created_by="user_1")
        assert len(result.nodes) == 1
        assert len(result.edges) == 0
        assert result.nodes[0].name == "Paris"
        assert result.nodes[0].lat_lng.lat == 48.8566
        assert result.nodes[0].order_index == 0

    def test_two_locations_produce_one_edge(self):
        locations = [
            {
                "name": "Paris",
                "lat": 48.8566,
                "lng": 2.3522,
                "duration_hours": 48,
                "travel_time_hours": 6,
                "distance_km": 450,
            },
            {"name": "Lyon", "lat": 45.764, "lng": 4.8357, "duration_hours": 24},
        ]
        result = assemble_dag(notes=[], geocoded_locations=locations, created_by="user_1")
        assert len(result.nodes) == 2
        assert len(result.edges) == 1
        edge = result.edges[0]
        assert edge.from_node_id == result.nodes[0].id
        assert edge.to_node_id == result.nodes[1].id
        assert edge.travel_time_hours == 6
        assert edge.distance_km == 450

    def test_linear_dag_preserves_order(self):
        locations = [
            {"name": "A", "lat": 0, "lng": 0, "duration_hours": 12},
            {"name": "B", "lat": 1, "lng": 1, "duration_hours": 12, "travel_time_hours": 2},
            {"name": "C", "lat": 2, "lng": 2, "duration_hours": 12, "travel_time_hours": 3},
        ]
        result = assemble_dag(notes=[], geocoded_locations=locations, created_by="user_1")
        assert len(result.nodes) == 3
        assert len(result.edges) == 2
        assert [n.order_index for n in result.nodes] == [0, 1, 2]
        assert [n.name for n in result.nodes] == ["A", "B", "C"]

    def test_arrival_times_chain_correctly(self):
        start = datetime(2026, 6, 1, 10, 0, tzinfo=UTC)
        locations = [
            {"name": "A", "lat": 0, "lng": 0, "duration_hours": 24, "travel_time_hours": 2},
            {"name": "B", "lat": 1, "lng": 1, "duration_hours": 12},
        ]
        result = assemble_dag(
            notes=[], geocoded_locations=locations, created_by="user_1", start_date=start
        )
        node_a = result.nodes[0]
        node_b = result.nodes[1]

        assert node_a.arrival_time == start
        assert node_a.departure_time == start + timedelta(hours=24)
        # B arrival = A departure + travel time
        expected_b_arrival = start + timedelta(hours=24) + timedelta(hours=2)
        assert node_b.arrival_time == expected_b_arrival

    def test_travel_mode_inference_flight(self):
        locations = [
            {
                "name": "New York",
                "lat": 40.7,
                "lng": -74.0,
                "duration_hours": 48,
                "travel_time_hours": 7,
                "distance_km": 5800,
            },
            {"name": "London", "lat": 51.5, "lng": -0.12, "duration_hours": 48},
        ]
        result = assemble_dag(notes=[], geocoded_locations=locations, created_by="user_1")
        assert result.edges[0].travel_mode == "flight"

    def test_travel_mode_inference_walk(self):
        locations = [
            {
                "name": "Hotel",
                "lat": 48.856,
                "lng": 2.352,
                "duration_hours": 1,
                "travel_time_hours": 0.1,
                "distance_km": 0.5,
            },
            {"name": "Restaurant", "lat": 48.857, "lng": 2.353, "duration_hours": 2},
        ]
        result = assemble_dag(notes=[], geocoded_locations=locations, created_by="user_1")
        assert result.edges[0].travel_mode == "walk"

    def test_travel_mode_inference_drive(self):
        locations = [
            {
                "name": "A",
                "lat": 0,
                "lng": 0,
                "duration_hours": 12,
                "travel_time_hours": 3,
                "distance_km": 200,
            },
            {"name": "B", "lat": 1, "lng": 1, "duration_hours": 12},
        ]
        result = assemble_dag(notes=[], geocoded_locations=locations, created_by="user_1")
        assert result.edges[0].travel_mode == "drive"

    def test_node_type_inference(self):
        locations = [
            {"name": "Hilton Hotel Paris", "lat": 0, "lng": 0, "duration_hours": 12},
            {"name": "Le Bistro Café", "lat": 1, "lng": 1, "duration_hours": 2},
            {"name": "Alps Hiking Tour", "lat": 2, "lng": 2, "duration_hours": 8},
            {"name": "Louvre Museum", "lat": 3, "lng": 3, "duration_hours": 4},
            {"name": "Paris", "lat": 4, "lng": 4, "duration_hours": 24},
        ]
        result = assemble_dag(notes=[], geocoded_locations=locations, created_by="user_1")
        types = [n.type.value for n in result.nodes]
        assert types == ["hotel", "restaurant", "activity", "place", "city"]

    def test_participant_ids_default_to_none(self):
        locations = [
            {"name": "Paris", "lat": 48.856, "lng": 2.352, "duration_hours": 24}
        ]
        result = assemble_dag(notes=[], geocoded_locations=locations, created_by="user_1")
        assert result.nodes[0].participant_ids is None

    def test_place_id_preserved(self):
        locations = [
            {
                "name": "Eiffel Tower",
                "lat": 48.858,
                "lng": 2.294,
                "duration_hours": 3,
                "place_id": "ChIJLU7jZClu5kcR4PcOOO6p3I0",
            }
        ]
        result = assemble_dag(notes=[], geocoded_locations=locations, created_by="user_1")
        assert result.nodes[0].place_id == "ChIJLU7jZClu5kcR4PcOOO6p3I0"

    def test_explicit_null_travel_fields_treated_as_defaults(self):
        """Gemini may output travel_time_hours: null instead of omitting the key."""
        locations = [
            {
                "name": "A",
                "lat": 0,
                "lng": 0,
                "duration_hours": None,
                "travel_time_hours": None,
                "distance_km": None,
            },
            {"name": "B", "lat": 1, "lng": 1, "duration_hours": 12},
        ]
        result = assemble_dag(notes=[], geocoded_locations=locations, created_by="user_1")
        assert len(result.nodes) == 2
        assert len(result.edges) == 1
        # duration_hours None -> default 24
        node_a = result.nodes[0]
        assert node_a.departure_time == node_a.arrival_time + timedelta(hours=24)
        # travel_time_hours None -> default 0
        assert result.edges[0].travel_time_hours == 0

    def test_unique_ids(self):
        locations = [
            {"name": "A", "lat": 0, "lng": 0, "duration_hours": 12},
            {"name": "B", "lat": 1, "lng": 1, "duration_hours": 12},
            {"name": "C", "lat": 2, "lng": 2, "duration_hours": 12},
        ]
        result = assemble_dag(notes=[], geocoded_locations=locations, created_by="user_1")
        node_ids = [n.id for n in result.nodes]
        edge_ids = [e.id for e in result.edges]
        all_ids = node_ids + edge_ids
        assert len(all_ids) == len(set(all_ids)), "All IDs must be unique"


class TestAssembleDagBranching:
    """Tests for branching DAG assembly."""

    def test_single_branch_group_creates_divergence_and_merge(self):
        """Hotel -> (Museum | Beach) -> Dinner: 4 nodes, 4 edges."""
        locations = [
            {"name": "Hotel", "lat": 48.8, "lng": 2.3, "duration_hours": 12,
             "travel_time_hours": 0.5, "distance_km": 5},
            {"name": "Museum", "lat": 48.9, "lng": 2.4, "duration_hours": 3,
             "branch_group": "day3", "connects_from_index": 0, "connects_to_index": 3,
             "travel_time_hours": 0.5, "distance_km": 10},
            {"name": "Beach", "lat": 48.7, "lng": 2.2, "duration_hours": 3,
             "branch_group": "day3", "connects_from_index": 0, "connects_to_index": 3,
             "travel_time_hours": 0.3, "distance_km": 8},
            {"name": "Dinner", "lat": 48.85, "lng": 2.35, "duration_hours": 2},
        ]
        result = assemble_dag(notes=[], geocoded_locations=locations, created_by="user_1")
        assert len(result.nodes) == 4
        # 4 edges: Hotel->Museum, Hotel->Beach, Museum->Dinner, Beach->Dinner
        assert len(result.edges) == 4

        node_names = {n.name: n for n in result.nodes}
        edge_pairs = {(e.from_node_id, e.to_node_id) for e in result.edges}

        hotel = node_names["Hotel"]
        museum = node_names["Museum"]
        beach = node_names["Beach"]
        dinner = node_names["Dinner"]

        assert (hotel.id, museum.id) in edge_pairs
        assert (hotel.id, beach.id) in edge_pairs
        assert (museum.id, dinner.id) in edge_pairs
        assert (beach.id, dinner.id) in edge_pairs
        # No direct Hotel -> Dinner edge
        assert (hotel.id, dinner.id) not in edge_pairs

    def test_no_merge_target_creates_divergence_only(self):
        """Branch group without connects_to_index and no spine node after."""
        locations = [
            {"name": "Start", "lat": 0, "lng": 0, "duration_hours": 12,
             "travel_time_hours": 1},
            {"name": "Option A", "lat": 1, "lng": 1, "duration_hours": 6,
             "branch_group": "split", "connects_from_index": 0,
             "travel_time_hours": 1, "distance_km": 50},
            {"name": "Option B", "lat": 2, "lng": 2, "duration_hours": 6,
             "branch_group": "split", "connects_from_index": 0,
             "travel_time_hours": 2, "distance_km": 100},
        ]
        result = assemble_dag(notes=[], geocoded_locations=locations, created_by="user_1")
        assert len(result.nodes) == 3
        # 2 edges: Start->OptionA, Start->OptionB (no merge edges)
        assert len(result.edges) == 2

        node_names = {n.name: n for n in result.nodes}
        edge_pairs = {(e.from_node_id, e.to_node_id) for e in result.edges}
        assert (node_names["Start"].id, node_names["Option A"].id) in edge_pairs
        assert (node_names["Start"].id, node_names["Option B"].id) in edge_pairs

    def test_mixed_linear_and_branching(self):
        """A -> B -> (C1 | C2) -> D -> E"""
        locations = [
            {"name": "A", "lat": 0, "lng": 0, "duration_hours": 12,
             "travel_time_hours": 2, "distance_km": 100},
            {"name": "B", "lat": 1, "lng": 1, "duration_hours": 12,
             "travel_time_hours": 1, "distance_km": 50},
            {"name": "C1", "lat": 2, "lng": 2, "duration_hours": 6,
             "branch_group": "mid_split", "connects_from_index": 1, "connects_to_index": 4,
             "travel_time_hours": 0.5, "distance_km": 20},
            {"name": "C2", "lat": 3, "lng": 3, "duration_hours": 6,
             "branch_group": "mid_split", "connects_from_index": 1, "connects_to_index": 4,
             "travel_time_hours": 1, "distance_km": 40},
            {"name": "D", "lat": 4, "lng": 4, "duration_hours": 12,
             "travel_time_hours": 3, "distance_km": 200},
            {"name": "E", "lat": 5, "lng": 5, "duration_hours": 12},
        ]
        result = assemble_dag(notes=[], geocoded_locations=locations, created_by="user_1")
        assert len(result.nodes) == 6
        # Edges: A->B, B->C1, B->C2, C1->D, C2->D, D->E = 6 total
        # (No B->D edge since branch group replaces it)
        assert len(result.edges) == 6

        node_names = {n.name: n for n in result.nodes}
        edge_pairs = {(e.from_node_id, e.to_node_id) for e in result.edges}
        assert (node_names["A"].id, node_names["B"].id) in edge_pairs
        assert (node_names["B"].id, node_names["C1"].id) in edge_pairs
        assert (node_names["B"].id, node_names["C2"].id) in edge_pairs
        assert (node_names["C1"].id, node_names["D"].id) in edge_pairs
        assert (node_names["C2"].id, node_names["D"].id) in edge_pairs
        assert (node_names["D"].id, node_names["E"].id) in edge_pairs
        # No direct B->D
        assert (node_names["B"].id, node_names["D"].id) not in edge_pairs

    def test_no_branch_fields_produces_linear_dag(self):
        """Backward compatibility: no branch_group = same linear DAG."""
        locations = [
            {"name": "A", "lat": 0, "lng": 0, "duration_hours": 12, "travel_time_hours": 2},
            {"name": "B", "lat": 1, "lng": 1, "duration_hours": 12, "travel_time_hours": 3},
            {"name": "C", "lat": 2, "lng": 2, "duration_hours": 12},
        ]
        result = assemble_dag(notes=[], geocoded_locations=locations, created_by="user_1")
        assert len(result.nodes) == 3
        assert len(result.edges) == 2
        assert result.edges[0].from_node_id == result.nodes[0].id
        assert result.edges[0].to_node_id == result.nodes[1].id
        assert result.edges[1].from_node_id == result.nodes[1].id
        assert result.edges[1].to_node_id == result.nodes[2].id

    def test_multiple_branch_groups(self):
        """Two separate splits: A -> (B1|B2) -> C -> (D1|D2) -> E"""
        locations = [
            {"name": "A", "lat": 0, "lng": 0, "duration_hours": 12},
            {"name": "B1", "lat": 1, "lng": 1, "duration_hours": 4,
             "branch_group": "split1", "connects_from_index": 0, "connects_to_index": 3,
             "travel_time_hours": 1},
            {"name": "B2", "lat": 2, "lng": 2, "duration_hours": 4,
             "branch_group": "split1", "connects_from_index": 0, "connects_to_index": 3,
             "travel_time_hours": 1},
            {"name": "C", "lat": 3, "lng": 3, "duration_hours": 12},
            {"name": "D1", "lat": 4, "lng": 4, "duration_hours": 3,
             "branch_group": "split2", "connects_from_index": 3, "connects_to_index": 6,
             "travel_time_hours": 0.5},
            {"name": "D2", "lat": 5, "lng": 5, "duration_hours": 3,
             "branch_group": "split2", "connects_from_index": 3, "connects_to_index": 6,
             "travel_time_hours": 0.5},
            {"name": "E", "lat": 6, "lng": 6, "duration_hours": 12},
        ]
        result = assemble_dag(notes=[], geocoded_locations=locations, created_by="user_1")
        assert len(result.nodes) == 7
        # Spine edges: A->C (skipped), C->E (skipped) = 0
        # Branch split1: A->B1, A->B2, B1->C, B2->C = 4
        # Branch split2: C->D1, C->D2, D1->E, D2->E = 4
        assert len(result.edges) == 8

    def test_branch_arrival_times(self):
        """Branch nodes arrive at source departure + travel_time_hours."""
        start = datetime(2026, 6, 1, 10, 0, tzinfo=UTC)
        locations = [
            {"name": "Hotel", "lat": 0, "lng": 0, "duration_hours": 12},
            {"name": "Museum", "lat": 1, "lng": 1, "duration_hours": 3,
             "branch_group": "split", "connects_from_index": 0, "connects_to_index": 3,
             "travel_time_hours": 1},
            {"name": "Beach", "lat": 2, "lng": 2, "duration_hours": 3,
             "branch_group": "split", "connects_from_index": 0, "connects_to_index": 3,
             "travel_time_hours": 2},
            {"name": "Dinner", "lat": 3, "lng": 3, "duration_hours": 2},
        ]
        result = assemble_dag(
            notes=[], geocoded_locations=locations, created_by="user_1", start_date=start,
        )
        node_names = {n.name: n for n in result.nodes}
        hotel = node_names["Hotel"]
        museum = node_names["Museum"]
        beach = node_names["Beach"]

        # Hotel departs at 10:00 + 12h = 22:00
        assert hotel.departure_time == start + timedelta(hours=12)
        # Museum arrives at Hotel departure + 1h travel
        assert museum.arrival_time == hotel.departure_time + timedelta(hours=1)
        # Beach arrives at Hotel departure + 2h travel
        assert beach.arrival_time == hotel.departure_time + timedelta(hours=2)

    def test_merge_node_arrival_adjusted_to_latest_branch(self):
        """Merge node arrival shifts to accommodate the slowest branch."""
        start = datetime(2026, 6, 1, 10, 0, tzinfo=UTC)
        locations = [
            {"name": "Hotel", "lat": 0, "lng": 0, "duration_hours": 12},
            {"name": "Quick Trip", "lat": 1, "lng": 1, "duration_hours": 2,
             "branch_group": "split", "connects_from_index": 0, "connects_to_index": 3,
             "travel_time_hours": 0.5},
            {"name": "Long Trip", "lat": 2, "lng": 2, "duration_hours": 8,
             "branch_group": "split", "connects_from_index": 0, "connects_to_index": 3,
             "travel_time_hours": 1},
            {"name": "Dinner", "lat": 3, "lng": 3, "duration_hours": 2},
        ]
        result = assemble_dag(
            notes=[], geocoded_locations=locations, created_by="user_1", start_date=start,
        )
        node_names = {n.name: n for n in result.nodes}
        hotel = node_names["Hotel"]
        quick = node_names["Quick Trip"]
        long_ = node_names["Long Trip"]
        dinner = node_names["Dinner"]

        # Quick: arrives Hotel.dep + 0.5, departs +2h = Hotel.dep + 2.5h
        assert quick.departure_time == hotel.departure_time + timedelta(hours=2.5)
        # Long: arrives Hotel.dep + 1, departs +8h = Hotel.dep + 9h
        assert long_.departure_time == hotel.departure_time + timedelta(hours=9)
        # Dinner arrival should be the latest branch departure (Long Trip)
        assert dinner.arrival_time == long_.departure_time

    def test_fallback_heuristic_infers_from_position(self):
        """When connects_from/to are absent, infer from array position."""
        locations = [
            {"name": "Start", "lat": 0, "lng": 0, "duration_hours": 12},
            {"name": "Branch A", "lat": 1, "lng": 1, "duration_hours": 4,
             "branch_group": "auto_split", "travel_time_hours": 1},
            {"name": "Branch B", "lat": 2, "lng": 2, "duration_hours": 4,
             "branch_group": "auto_split", "travel_time_hours": 1},
            {"name": "End", "lat": 3, "lng": 3, "duration_hours": 12},
        ]
        result = assemble_dag(notes=[], geocoded_locations=locations, created_by="user_1")
        assert len(result.nodes) == 4
        # Should infer: diverge from Start (index 0), merge at End (index 3)
        assert len(result.edges) == 4

        node_names = {n.name: n for n in result.nodes}
        edge_pairs = {(e.from_node_id, e.to_node_id) for e in result.edges}
        assert (node_names["Start"].id, node_names["Branch A"].id) in edge_pairs
        assert (node_names["Start"].id, node_names["Branch B"].id) in edge_pairs
        assert (node_names["Branch A"].id, node_names["End"].id) in edge_pairs
        assert (node_names["Branch B"].id, node_names["End"].id) in edge_pairs

    def test_name_based_connects_from_and_to(self):
        """Branch stops use connects_from/connects_to with stop names instead of indices."""
        locations = [
            {"name": "Paris Hotel", "lat": 48.8, "lng": 2.3, "duration_hours": 12},
            {"name": "Louvre Museum", "lat": 48.9, "lng": 2.4, "duration_hours": 3,
             "branch_group": "day2", "connects_from": "Paris Hotel",
             "connects_to": "Dinner in Montmartre",
             "travel_time_hours": 0.5, "distance_km": 2},
            {"name": "Eiffel Tower", "lat": 48.86, "lng": 2.29, "duration_hours": 2,
             "branch_group": "day2", "connects_from": "Paris Hotel",
             "connects_to": "Dinner in Montmartre",
             "travel_time_hours": 0.3, "distance_km": 3},
            {"name": "Dinner in Montmartre", "lat": 48.89, "lng": 2.34,
             "duration_hours": 2},
        ]
        result = assemble_dag(notes=[], geocoded_locations=locations, created_by="user_1")
        assert len(result.nodes) == 4
        assert len(result.edges) == 4

        node_names = {n.name: n for n in result.nodes}
        edge_pairs = {(e.from_node_id, e.to_node_id) for e in result.edges}

        hotel = node_names["Paris Hotel"]
        louvre = node_names["Louvre Museum"]
        eiffel = node_names["Eiffel Tower"]
        dinner = node_names["Dinner in Montmartre"]

        assert (hotel.id, louvre.id) in edge_pairs
        assert (hotel.id, eiffel.id) in edge_pairs
        assert (louvre.id, dinner.id) in edge_pairs
        assert (eiffel.id, dinner.id) in edge_pairs
        assert (hotel.id, dinner.id) not in edge_pairs

    def test_name_based_with_case_mismatch(self):
        """Name resolution is case-insensitive."""
        locations = [
            {"name": "Beach Resort", "lat": 0, "lng": 0, "duration_hours": 12},
            {"name": "Surfing", "lat": 1, "lng": 1, "duration_hours": 4,
             "branch_group": "water", "connects_from": "beach resort",
             "connects_to": "SUNSET DINNER",
             "travel_time_hours": 0.5},
            {"name": "Snorkeling", "lat": 2, "lng": 2, "duration_hours": 4,
             "branch_group": "water", "connects_from": "beach resort",
             "connects_to": "SUNSET DINNER",
             "travel_time_hours": 0.3},
            {"name": "Sunset Dinner", "lat": 3, "lng": 3, "duration_hours": 2},
        ]
        result = assemble_dag(notes=[], geocoded_locations=locations, created_by="user_1")
        assert len(result.nodes) == 4
        assert len(result.edges) == 4

        node_names = {n.name: n for n in result.nodes}
        edge_pairs = {(e.from_node_id, e.to_node_id) for e in result.edges}
        assert (node_names["Beach Resort"].id, node_names["Surfing"].id) in edge_pairs
        assert (node_names["Beach Resort"].id, node_names["Snorkeling"].id) in edge_pairs
        assert (node_names["Surfing"].id, node_names["Sunset Dinner"].id) in edge_pairs
        assert (node_names["Snorkeling"].id, node_names["Sunset Dinner"].id) in edge_pairs

    def test_name_based_falls_back_to_index_when_name_not_found(self):
        """If connects_from name doesn't match, falls back to connects_from_index."""
        locations = [
            {"name": "Start", "lat": 0, "lng": 0, "duration_hours": 12},
            {"name": "Branch A", "lat": 1, "lng": 1, "duration_hours": 4,
             "branch_group": "split",
             "connects_from": "Nonexistent Stop",
             "connects_from_index": 0,
             "connects_to": "Also Nonexistent",
             "connects_to_index": 3,
             "travel_time_hours": 1},
            {"name": "Branch B", "lat": 2, "lng": 2, "duration_hours": 4,
             "branch_group": "split",
             "connects_from": "Nonexistent Stop",
             "connects_from_index": 0,
             "connects_to": "Also Nonexistent",
             "connects_to_index": 3,
             "travel_time_hours": 1},
            {"name": "End", "lat": 3, "lng": 3, "duration_hours": 12},
        ]
        result = assemble_dag(notes=[], geocoded_locations=locations, created_by="user_1")
        assert len(result.nodes) == 4
        assert len(result.edges) == 4

        node_names = {n.name: n for n in result.nodes}
        edge_pairs = {(e.from_node_id, e.to_node_id) for e in result.edges}
        assert (node_names["Start"].id, node_names["Branch A"].id) in edge_pairs
        assert (node_names["Start"].id, node_names["Branch B"].id) in edge_pairs
        assert (node_names["Branch A"].id, node_names["End"].id) in edge_pairs
        assert (node_names["Branch B"].id, node_names["End"].id) in edge_pairs

    def test_name_based_no_merge(self):
        """Name-based connects_to as null means no merge edges."""
        locations = [
            {"name": "Base Camp", "lat": 0, "lng": 0, "duration_hours": 12},
            {"name": "North Trail", "lat": 1, "lng": 1, "duration_hours": 6,
             "branch_group": "hike", "connects_from": "Base Camp",
             "travel_time_hours": 2},
            {"name": "South Trail", "lat": 2, "lng": 2, "duration_hours": 6,
             "branch_group": "hike", "connects_from": "Base Camp",
             "travel_time_hours": 1.5},
        ]
        result = assemble_dag(notes=[], geocoded_locations=locations, created_by="user_1")
        assert len(result.nodes) == 3
        assert len(result.edges) == 2

        node_names = {n.name: n for n in result.nodes}
        edge_pairs = {(e.from_node_id, e.to_node_id) for e in result.edges}
        assert (node_names["Base Camp"].id, node_names["North Trail"].id) in edge_pairs
        assert (node_names["Base Camp"].id, node_names["South Trail"].id) in edge_pairs
