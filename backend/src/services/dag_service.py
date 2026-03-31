"""DAG service: create plans with nodes/edges from assembler output, get full DAG.

Includes cascade engine for propagating schedule changes downstream through the DAG.
"""

import asyncio
import logging
import time
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from shared.repositories.edge_repository import EdgeRepository
from shared.repositories.node_repository import NodeRepository
from shared.repositories.plan_repository import PlanRepository
from shared.repositories.trip_repository import TripRepository
from shared.tools.id_gen import edge_id, node_id, plan_id

if TYPE_CHECKING:
    from backend.src.services.route_service import RouteService

from shared.dag.assembler import AssemblyResult
from shared.dag.cascade import compute_cascade, parse_dt
from shared.dag.cycle import CycleDetectedError, detect_cycle
from shared.models import (
    Edge,
    LatLng,
    Node,
    NodeType,
    NotificationType,
    Plan,
    PlanStatus,
    RelatedEntity,
    TravelMode,
)
from shared.tools.timezone import resolve_timezone

logger = logging.getLogger(__name__)


class DAGService:
    def __init__(
        self,
        trip_repo: TripRepository,
        plan_repo: PlanRepository,
        node_repo: NodeRepository,
        edge_repo: EdgeRepository,
        route_service: "RouteService | None" = None,
    ):
        self._trip_repo = trip_repo
        self._plan_repo = plan_repo
        self._node_repo = node_repo
        self._edge_repo = edge_repo
        self._route_service = route_service

    async def _find_existing_edge(
        self,
        trip_id: str,
        plan_id: str,
        from_node_id: str,
        to_node_id: str,
    ) -> dict | None:
        """Return an existing edge between the two nodes, or None."""
        edges = await self._edge_repo.list_by_plan(trip_id, plan_id)
        for e in edges:
            if e["from_node_id"] == from_node_id and e["to_node_id"] == to_node_id:
                return e
        return None

    async def _create_edge_if_new(
        self,
        trip_id: str,
        plan_id: str,
        edge: Edge,
        from_latlng: dict | None = None,
        to_latlng: dict | None = None,
    ) -> dict:
        """Create an edge only if no edge exists between the same from/to pair.

        Returns the existing edge dict if a duplicate is found, otherwise
        creates the new edge and returns its dict.

        If the new edge has no route_polyline, is not a flight, and a
        RouteService is available, fires a background task to fetch and
        patch the polyline.
        """
        existing = await self._find_existing_edge(
            trip_id, plan_id, edge.from_node_id, edge.to_node_id,
        )
        if existing:
            return existing
        await self._edge_repo.create_edge(trip_id, plan_id, edge)
        if (
            edge.route_polyline is None
            and edge.travel_mode != TravelMode.FLIGHT
            and self._route_service is not None
        ):
            asyncio.create_task(
                self._route_service.fetch_and_patch_polyline(
                    trip_id=trip_id,
                    plan_id=plan_id,
                    edge_id=edge.id,
                    from_latlng=from_latlng,
                    to_latlng=to_latlng,
                    travel_mode=str(edge.travel_mode),
                    edge_repo=self._edge_repo,
                )
            )
        return edge.model_dump(mode="json")

    async def create_plan_from_assembly(
        self,
        trip_id: str,
        assembly: AssemblyResult,
        created_by: str,
        plan_name: str = "Main Route",
    ) -> dict:
        """Create a new plan with nodes and edges from assembler output.

        Sets the plan as the trip's active plan.
        Returns summary with plan_id, nodes_created, edges_created.
        """
        plan = Plan(
            id=plan_id(),
            name=plan_name,
            status=PlanStatus.ACTIVE,
            created_by=created_by,
            parent_plan_id=None,
            created_at=datetime.now(UTC),
        )
        await self._plan_repo.create_plan(trip_id, plan)

        if assembly.nodes:
            await self._node_repo.batch_create(trip_id, plan.id, assembly.nodes)
        if assembly.edges:
            await self._edge_repo.batch_create(trip_id, plan.id, assembly.edges)

        await self._trip_repo.update_trip(trip_id, {
            "active_plan_id": plan.id,
            "updated_at": datetime.now(UTC).isoformat(),
        })

        return {
            "plan_id": plan.id,
            "nodes_created": len(assembly.nodes),
            "edges_created": len(assembly.edges),
        }

    async def get_full_dag(
        self, trip_id: str, plan_id: str
    ) -> dict:
        """Get the full DAG: plan + all nodes + all edges."""
        plan = await self._plan_repo.get_plan_or_raise(trip_id, plan_id)
        nodes = await self._node_repo.list_by_plan(trip_id, plan_id)
        edges = await self._edge_repo.list_by_plan(trip_id, plan_id)
        return {
            "plan": plan.model_dump(mode="json"),
            "nodes": nodes,
            "edges": edges,
        }

    async def create_node(
        self,
        trip_id: str,
        plan_id: str,
        name: str,
        node_type: str,
        lat: float,
        lng: float,
        connect_after_node_id: str | None,
        travel_mode: str,
        travel_time_hours: float,
        distance_km: float | None,
        created_by: str,
        place_id: str | None = None,
        arrival_time: str | None = None,
        departure_time: str | None = None,
        connect_before_node_id: str | None = None,
        route_polyline: str | None = None,
    ) -> dict:
        """Create a new node, optionally inserting it after an existing node.

        arrival_time / departure_time come from the frontend (user-provided).
        If not provided, arrival is computed from the source node's departure
        + travel time when connecting, or defaults to now.
        """
        all_nodes = await self._node_repo.list_by_plan(trip_id, plan_id)
        max_order = max((n.get("order_index", 0) for n in all_nodes), default=0)

        # Fetch source node upfront when connecting after an existing node so
        # we have its lat_lng available for polyline fetching regardless of
        # whether arrival_time was supplied by the caller.
        source = None
        if connect_after_node_id:
            source = await self._node_repo.get_node_or_raise(
                trip_id, plan_id, connect_after_node_id
            )

        # Resolve arrival
        resolved_arrival: datetime
        if arrival_time:
            resolved_arrival = parse_dt(arrival_time)
        elif source is not None:
            departure = source.departure_time
            if departure is None and source.arrival_time:
                departure = parse_dt(source.arrival_time)
            elif departure:
                departure = parse_dt(departure)
            resolved_arrival = (
                (departure + timedelta(hours=travel_time_hours)) if departure
                else datetime.now(UTC)
            )
        else:
            resolved_arrival = datetime.now(UTC)

        # Resolve departure
        resolved_departure: datetime | None = None
        if departure_time:
            resolved_departure = parse_dt(departure_time)

        new_node = Node(
            id=node_id(),
            name=name,
            type=NodeType(node_type),
            lat_lng=LatLng(lat=lat, lng=lng),
            arrival_time=resolved_arrival,
            departure_time=resolved_departure,
            timezone=resolve_timezone(lat, lng),
            place_id=place_id,
            order_index=max_order + 1,
            created_by=created_by,
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )
        await self._node_repo.create_node(trip_id, plan_id, new_node)

        new_latlng = {"lat": lat, "lng": lng}

        edge_dict = None
        if connect_after_node_id:
            source_latlng: dict | None = None
            if source is not None and source.lat_lng is not None:
                ll = source.lat_lng
                source_latlng = {"lat": ll.lat, "lng": ll.lng}
            edge = Edge(
                id=edge_id(),
                from_node_id=connect_after_node_id,
                to_node_id=new_node.id,
                travel_mode=TravelMode(travel_mode),
                travel_time_hours=travel_time_hours,
                distance_km=distance_km,
                route_polyline=route_polyline,
            )
            edge_dict = await self._create_edge_if_new(
                trip_id, plan_id, edge,
                from_latlng=source_latlng,
                to_latlng=new_latlng,
            )
        elif connect_before_node_id:
            before_node = await self._node_repo.get_node_or_raise(
                trip_id, plan_id, connect_before_node_id
            )
            before_latlng: dict | None = None
            if before_node.lat_lng is not None:
                bl = before_node.lat_lng
                before_latlng = {"lat": bl.lat, "lng": bl.lng}
            edge = Edge(
                id=edge_id(),
                from_node_id=new_node.id,
                to_node_id=connect_before_node_id,
                travel_mode=TravelMode(travel_mode),
                travel_time_hours=travel_time_hours,
                distance_km=distance_km,
                route_polyline=route_polyline,
            )
            edge_dict = await self._create_edge_if_new(
                trip_id, plan_id, edge,
                from_latlng=new_latlng,
                to_latlng=before_latlng,
            )

        return {
            "node": new_node.model_dump(mode="json"),
            "edge": edge_dict,
        }

    async def delete_node(
        self,
        trip_id: str,
        plan_id: str,
        node_id: str,
    ) -> dict:
        """Delete a node and reconnect edges around it.

        - If the node has one incoming edge and one outgoing edge,
          reconnect the incoming source directly to the outgoing target.
        - If the node has multiple incoming or outgoing edges, just
          delete all edges connected to it (can't auto-reconnect).
        """
        all_edges = await self._edge_repo.list_by_plan(trip_id, plan_id)

        incoming = [e for e in all_edges if e["to_node_id"] == node_id]
        outgoing = [e for e in all_edges if e["from_node_id"] == node_id]

        # Delete all edges connected to this node
        for e in incoming + outgoing:
            await self._edge_repo.delete_edge(trip_id, plan_id, e["id"])

        # If exactly one incoming and one outgoing, reconnect
        reconnected_edge = None
        if len(incoming) == 1 and len(outgoing) == 1:
            new_edge = Edge(
                id=edge_id(),
                from_node_id=incoming[0]["from_node_id"],
                to_node_id=outgoing[0]["to_node_id"],
                travel_mode=TravelMode(
                    incoming[0].get("travel_mode", "drive")
                ),
                travel_time_hours=(
                    incoming[0].get("travel_time_hours", 0)
                    + outgoing[0].get("travel_time_hours", 0)
                ),
                distance_km=None,
            )
            reconnected_edge = await self._create_edge_if_new(
                trip_id, plan_id, new_edge
            )

        await self._node_repo.delete_node(trip_id, plan_id, node_id)

        # Auto-cleanup stale participant_ids if DAG became linear
        cleaned = await self.cleanup_stale_participant_ids(trip_id, plan_id)

        return {
            "deleted_node_id": node_id,
            "deleted_edge_count": len(incoming) + len(outgoing),
            "reconnected_edge": reconnected_edge,
            "participant_ids_cleaned": cleaned,
        }

    async def create_branch(
        self,
        trip_id: str,
        plan_id: str,
        from_node_id: str,
        name: str,
        node_type: str,
        lat: float,
        lng: float,
        travel_mode: str,
        travel_time_hours: float,
        distance_km: float | None,
        connect_to_node_id: str | None,
        created_by: str,
        place_id: str | None = None,
        arrival_time: str | None = None,
        departure_time: str | None = None,
        route_polyline: str | None = None,
    ) -> dict:
        """Create a new node branching off from an existing node.

        Creates the node, an edge from source to new node, and optionally
        an edge from new node to a merge target.
        """
        source = await self._node_repo.get_node_or_raise(trip_id, plan_id, from_node_id)

        # Resolve arrival
        if arrival_time:
            resolved_arrival = parse_dt(arrival_time)
        else:
            departure = source.departure_time
            if departure is None and source.arrival_time:
                departure = parse_dt(source.arrival_time)
            elif departure:
                departure = parse_dt(departure)
            resolved_arrival = (
                (departure + timedelta(hours=travel_time_hours)) if departure
                else datetime.now(UTC)
            )

        # Resolve departure
        resolved_departure: datetime | None = None
        if departure_time:
            resolved_departure = parse_dt(departure_time)

        all_nodes = await self._node_repo.list_by_plan(trip_id, plan_id)
        max_order = max((n.get("order_index", 0) for n in all_nodes), default=0)

        new_node = Node(
            id=node_id(),
            name=name,
            type=NodeType(node_type),
            lat_lng=LatLng(lat=lat, lng=lng),
            arrival_time=resolved_arrival,
            departure_time=resolved_departure,
            timezone=resolve_timezone(lat, lng),
            place_id=place_id,
            order_index=max_order + 1,
            created_by=created_by,
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )
        await self._node_repo.create_node(trip_id, plan_id, new_node)

        new_latlng = {"lat": lat, "lng": lng}

        source_latlng: dict | None = None
        if source.lat_lng is not None:
            ll = source.lat_lng
            source_latlng = {"lat": ll.lat, "lng": ll.lng}

        branch_edge = Edge(
            id=edge_id(),
            from_node_id=from_node_id,
            to_node_id=new_node.id,
            travel_mode=TravelMode(travel_mode),
            travel_time_hours=travel_time_hours,
            distance_km=distance_km,
            route_polyline=route_polyline,
        )
        branch_edge_dict = await self._create_edge_if_new(
            trip_id, plan_id, branch_edge,
            from_latlng=source_latlng,
            to_latlng=new_latlng,
        )

        merge_edge_dict = None
        if connect_to_node_id:
            merge_target = await self._node_repo.get_node_or_raise(
                trip_id, plan_id, connect_to_node_id
            )
            merge_target_latlng: dict | None = None
            if merge_target.lat_lng is not None:
                mt_ll = merge_target.lat_lng
                merge_target_latlng = {"lat": mt_ll.lat, "lng": mt_ll.lng}
            merge_edge = Edge(
                id=edge_id(),
                from_node_id=new_node.id,
                to_node_id=connect_to_node_id,
                travel_mode=TravelMode(travel_mode),
                travel_time_hours=travel_time_hours,
                distance_km=distance_km,
                route_polyline=None,
            )
            merge_edge_dict = await self._create_edge_if_new(
                trip_id, plan_id, merge_edge,
                from_latlng=new_latlng,
                to_latlng=merge_target_latlng,
            )

        return {
            "node": new_node.model_dump(mode="json"),
            "edge": branch_edge_dict,
            "merge_edge": merge_edge_dict,
        }

    async def update_node_with_cascade_preview(
        self,
        trip_id: str,
        plan_id: str,
        node_id: str,
        updates: dict[str, Any],
        client_updated_at: str | None = None,
        edited_by: str | None = None,
        notification_service=None,
    ) -> dict:
        """Update a node and compute cascade preview for downstream nodes.

        If client_updated_at is provided, compares with the node's current
        updated_at. If they differ (another user edited concurrently),
        sends an edit_conflict notification. Last-write-wins.

        Returns the updated node and a cascade_preview with affected nodes.
        """
        node = await self._node_repo.get_node_or_raise(trip_id, plan_id, node_id)
        node_dict = node.model_dump(mode="json")

        # Conflict detection: compare timestamps
        conflict = False
        if client_updated_at and node_dict.get("updated_at"):
            server_ts = parse_dt(node_dict["updated_at"])
            client_ts = parse_dt(client_updated_at)
            if abs((server_ts - client_ts).total_seconds()) > 1:
                conflict = True
                if notification_service and edited_by:
                    trip = await self._trip_repo.get_trip_or_raise(trip_id)
                    other_editors = [
                        uid for uid in trip.participants
                        if uid != edited_by
                    ]
                    if other_editors:
                        await notification_service.create_notification(
                            trip_id=trip_id,
                            notification_type=NotificationType.EDIT_CONFLICT,
                            message=f"Node '{node_dict.get('name', '')}' was edited concurrently",
                            target_user_ids=other_editors,
                            related_entity=RelatedEntity(type="node", id=node_id),
                        )

        for key, value in updates.items():
            node_dict[key] = value
        node_dict["updated_at"] = datetime.now(UTC).isoformat()

        # Re-resolve timezone if location changed
        if "lat" in updates or "lng" in updates:
            lat_lng = node_dict.get("lat_lng", {})
            lat = lat_lng.get("lat") if isinstance(lat_lng, dict) else getattr(lat_lng, "lat", None)
            lng = lat_lng.get("lng") if isinstance(lat_lng, dict) else getattr(lat_lng, "lng", None)
            if lat is not None and lng is not None:
                node_dict["timezone"] = resolve_timezone(lat, lng)

        await self._node_repo.update_node(trip_id, plan_id, node_id, node_dict)

        # Recalculate polylines for connected edges when location changed
        if "lat_lng" in updates:
            lat_lng = updates["lat_lng"]
            new_latlng = {"lat": lat_lng.get("lat"), "lng": lat_lng.get("lng")}
            await self._recalculate_connected_polylines(
                trip_id, plan_id, node_id, new_latlng
            )

        updated_node = Node(**node_dict)
        cascade_preview = await self._compute_cascade_preview(
            trip_id, plan_id, updated_node
        )

        return {
            "node": node_dict,
            "cascade_preview": cascade_preview,
            "conflict": conflict,
        }

    async def _recalculate_connected_polylines(
        self,
        trip_id: str,
        plan_id: str,
        node_id: str,
        new_latlng: dict,
    ) -> None:
        """Fire background polyline recalculation for all edges connected to a node.

        Called when a node's location changes. Skips flight edges.
        """
        if not self._route_service:
            return

        all_edges = await self._edge_repo.list_by_plan(trip_id, plan_id)
        connected = [
            e for e in all_edges
            if e["from_node_id"] == node_id or e["to_node_id"] == node_id
        ]

        for edge_dict in connected:
            travel_mode = edge_dict.get("travel_mode", "drive")
            if travel_mode == "flight":
                continue

            # Determine the other endpoint's latlng
            if edge_dict["from_node_id"] == node_id:
                from_latlng = new_latlng
                other_node = await self._node_repo.get_node_or_raise(
                    trip_id, plan_id, edge_dict["to_node_id"]
                )
                to_latlng = (
                    {"lat": other_node.lat_lng.lat, "lng": other_node.lat_lng.lng}
                    if other_node.lat_lng else None
                )
            else:
                to_latlng = new_latlng
                other_node = await self._node_repo.get_node_or_raise(
                    trip_id, plan_id, edge_dict["from_node_id"]
                )
                from_latlng = (
                    {"lat": other_node.lat_lng.lat, "lng": other_node.lat_lng.lng}
                    if other_node.lat_lng else None
                )

            asyncio.create_task(
                self._route_service.fetch_and_patch_polyline(
                    trip_id=trip_id,
                    plan_id=plan_id,
                    edge_id=edge_dict["id"],
                    from_latlng=from_latlng,
                    to_latlng=to_latlng,
                    travel_mode=travel_mode,
                    edge_repo=self._edge_repo,
                )
            )

        logger.debug(
            "Queued polyline recalculation for %d edges connected to node %s",
            len(connected), node_id,
        )

    async def _compute_cascade_preview(
        self,
        trip_id: str,
        plan_id: str,
        modified_node: Node,
    ) -> dict:
        """BFS from modified node to compute new arrival times for downstream nodes."""
        all_nodes_raw = await self._node_repo.list_by_plan(trip_id, plan_id)
        all_edges_raw = await self._edge_repo.list_by_plan(trip_id, plan_id)

        departure = modified_node.departure_time
        if departure is None:
            departure = parse_dt(modified_node.arrival_time)
        else:
            departure = parse_dt(departure)

        return compute_cascade(modified_node.id, departure, all_nodes_raw, all_edges_raw)

    async def confirm_cascade(
        self,
        trip_id: str,
        plan_id: str,
        node_id: str,
    ) -> dict:
        """Recompute and apply cascade from the given node atomically via batch write."""
        start = time.perf_counter()
        node = await self._node_repo.get_node_or_raise(trip_id, plan_id, node_id)
        preview = await self._compute_cascade_preview(trip_id, plan_id, node)

        affected = preview["affected_nodes"]
        if not affected:
            return {"updated_count": 0}

        batch = self._node_repo._db.batch()
        now = datetime.now(UTC).isoformat()
        for entry in affected:
            doc_ref = self._node_repo._collection(
                trip_id=trip_id, plan_id=plan_id
            ).document(entry["id"])
            batch.update(doc_ref, {
                "arrival_time": entry["new_arrival"],
                "departure_time": entry["new_departure"],
                "updated_at": now,
            })
        await batch.commit()

        elapsed = time.perf_counter() - start
        logger.info("cascade confirm completed in %.2fs (%d nodes updated)", elapsed, len(affected))
        return {"updated_count": len(affected)}


    async def cleanup_stale_participant_ids(
        self, trip_id: str, plan_id: str
    ) -> int:
        """Remove participant_ids from all nodes when the DAG is linear.

        A DAG is linear when no node has out-degree > 1 (no divergences).
        In a linear DAG, participant_ids are meaningless since there's only
        one path. Returns the number of nodes cleaned.
        """
        all_edges = await self._edge_repo.list_by_plan(trip_id, plan_id)
        out_degree: dict[str, int] = defaultdict(int)
        for e in all_edges:
            out_degree[e["from_node_id"]] += 1

        has_divergence = any(deg > 1 for deg in out_degree.values())
        if has_divergence:
            return 0

        all_nodes = await self._node_repo.list_by_plan(trip_id, plan_id)
        cleaned = 0
        for node_dict in all_nodes:
            if node_dict.get("participant_ids"):
                await self._node_repo.update_node(
                    trip_id, plan_id, node_dict["id"],
                    {"participant_ids": None},
                )
                cleaned += 1
        return cleaned

    async def create_standalone_edge(
        self,
        trip_id: str,
        plan_id: str,
        from_node_id: str,
        to_node_id: str,
        travel_mode: str = "drive",
        travel_time_hours: float = 0,
        distance_km: float | None = None,
        route_polyline: str | None = None,
    ) -> dict:
        """Create a standalone edge between two existing nodes."""
        from_node = await self._node_repo.get_node_or_raise(trip_id, plan_id, from_node_id)
        to_node = await self._node_repo.get_node_or_raise(trip_id, plan_id, to_node_id)

        from_latlng: dict | None = None
        if from_node.lat_lng is not None:
            ll = from_node.lat_lng
            from_latlng = {"lat": ll.lat, "lng": ll.lng}

        to_latlng: dict | None = None
        if to_node.lat_lng is not None:
            ll = to_node.lat_lng
            to_latlng = {"lat": ll.lat, "lng": ll.lng}

        edge = Edge(
            id=edge_id(),
            from_node_id=from_node_id,
            to_node_id=to_node_id,
            travel_mode=TravelMode(travel_mode),
            travel_time_hours=travel_time_hours,
            distance_km=distance_km,
            route_polyline=route_polyline,
        )
        return await self._create_edge_if_new(
            trip_id, plan_id, edge,
            from_latlng=from_latlng,
            to_latlng=to_latlng,
        )

    async def delete_edge_by_id(
        self,
        trip_id: str,
        plan_id: str,
        edge_id: str,
    ) -> dict:
        """Delete a single edge by ID."""
        await self._edge_repo.delete_edge(trip_id, plan_id, edge_id)
        return {"deleted_edge_id": edge_id}

    async def split_edge(
        self,
        trip_id: str,
        plan_id: str,
        split_edge_id: str,
        name: str,
        node_type: str,
        lat: float,
        lng: float,
        created_by: str,
        place_id: str | None = None,
        arrival_time: str | None = None,
        departure_time: str | None = None,
        leg_a_travel_mode: str | None = None,
        leg_a_travel_time_hours: float | None = None,
        leg_a_distance_km: float | None = None,
        leg_a_route_polyline: str | None = None,
        leg_b_travel_mode: str | None = None,
        leg_b_travel_time_hours: float | None = None,
        leg_b_distance_km: float | None = None,
        leg_b_route_polyline: str | None = None,
    ) -> dict:
        """Split an edge by inserting a new node between its endpoints.

        Atomically deletes the original edge and creates the new node plus
        two replacement edges via a Firestore batch write.
        """
        # Read original edge
        original = await self._edge_repo.get_edge(trip_id, plan_id, split_edge_id)
        if original is None:
            raise LookupError(f"Edge {split_edge_id} not found")

        from_node = await self._node_repo.get_node_or_raise(
            trip_id, plan_id, original.from_node_id
        )
        to_node = await self._node_repo.get_node_or_raise(
            trip_id, plan_id, original.to_node_id
        )

        # Default travel modes from original edge
        mode_a = TravelMode(leg_a_travel_mode or original.travel_mode or "drive")
        mode_b = TravelMode(leg_b_travel_mode or original.travel_mode or "drive")

        # Split travel time proportionally if not provided
        orig_time = original.travel_time_hours or 0
        orig_dist = original.distance_km or 0
        if leg_a_travel_time_hours is None and leg_b_travel_time_hours is None:
            if leg_a_distance_km and leg_b_distance_km and (leg_a_distance_km + leg_b_distance_km) > 0:
                ratio = leg_a_distance_km / (leg_a_distance_km + leg_b_distance_km)
                leg_a_travel_time_hours = orig_time * ratio
                leg_b_travel_time_hours = orig_time * (1 - ratio)
            else:
                leg_a_travel_time_hours = orig_time / 2
                leg_b_travel_time_hours = orig_time / 2

        # Compute order_index
        all_nodes = await self._node_repo.list_by_plan(trip_id, plan_id)
        max_order = max((n.get("order_index", 0) for n in all_nodes), default=0)

        # Resolve arrival time
        if arrival_time:
            resolved_arrival = parse_dt(arrival_time)
        else:
            departure = from_node.departure_time
            if departure is None and from_node.arrival_time:
                departure = parse_dt(from_node.arrival_time)
            elif departure:
                departure = parse_dt(departure)
            resolved_arrival = (
                (departure + timedelta(hours=leg_a_travel_time_hours or 0))
                if departure else datetime.now(UTC)
            )

        resolved_departure: datetime | None = None
        if departure_time:
            resolved_departure = parse_dt(departure_time)

        # Build entities
        new_node = Node(
            id=node_id(),
            name=name,
            type=NodeType(node_type),
            lat_lng=LatLng(lat=lat, lng=lng),
            arrival_time=resolved_arrival,
            departure_time=resolved_departure,
            timezone=resolve_timezone(lat, lng),
            place_id=place_id,
            order_index=max_order + 1,
            created_by=created_by,
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )

        edge_a = Edge(
            id=edge_id(),
            from_node_id=original.from_node_id,
            to_node_id=new_node.id,
            travel_mode=mode_a,
            travel_time_hours=leg_a_travel_time_hours,
            distance_km=leg_a_distance_km,
            route_polyline=leg_a_route_polyline,
        )

        edge_b = Edge(
            id=edge_id(),
            from_node_id=new_node.id,
            to_node_id=original.to_node_id,
            travel_mode=mode_b,
            travel_time_hours=leg_b_travel_time_hours,
            distance_km=leg_b_distance_km,
            route_polyline=leg_b_route_polyline,
        )

        # Atomic batch write: delete old edge + create node + create 2 edges
        batch = self._node_repo._db.batch()

        # Delete original edge
        old_edge_ref = self._edge_repo._collection(
            trip_id=trip_id, plan_id=plan_id
        ).document(split_edge_id)
        batch.delete(old_edge_ref)

        # Create node
        node_ref = self._node_repo._collection(
            trip_id=trip_id, plan_id=plan_id
        ).document(new_node.id)
        batch.set(node_ref, new_node.model_dump(mode="json"))

        # Create edges
        edge_a_ref = self._edge_repo._collection(
            trip_id=trip_id, plan_id=plan_id
        ).document(edge_a.id)
        batch.set(edge_a_ref, edge_a.model_dump(mode="json"))

        edge_b_ref = self._edge_repo._collection(
            trip_id=trip_id, plan_id=plan_id
        ).document(edge_b.id)
        batch.set(edge_b_ref, edge_b.model_dump(mode="json"))

        await batch.commit()

        logger.info(
            "split_edge: edge=%s -> node=%s, edge_a=%s, edge_b=%s",
            split_edge_id, new_node.id, edge_a.id, edge_b.id,
        )

        # Fire background polyline fetch for legs missing polylines
        new_latlng = {"lat": lat, "lng": lng}
        from_latlng = (
            {"lat": from_node.lat_lng.lat, "lng": from_node.lat_lng.lng}
            if from_node.lat_lng else None
        )
        to_latlng = (
            {"lat": to_node.lat_lng.lat, "lng": to_node.lat_lng.lng}
            if to_node.lat_lng else None
        )

        if self._route_service:
            if edge_a.route_polyline is None and mode_a != TravelMode.FLIGHT:
                asyncio.create_task(
                    self._route_service.fetch_and_patch_polyline(
                        trip_id, plan_id, edge_a.id,
                        from_latlng, new_latlng, str(mode_a), self._edge_repo,
                    )
                )
            if edge_b.route_polyline is None and mode_b != TravelMode.FLIGHT:
                asyncio.create_task(
                    self._route_service.fetch_and_patch_polyline(
                        trip_id, plan_id, edge_b.id,
                        new_latlng, to_latlng, str(mode_b), self._edge_repo,
                    )
                )

        return {
            "node": new_node.model_dump(mode="json"),
            "edge_a": edge_a.model_dump(mode="json"),
            "edge_b": edge_b.model_dump(mode="json"),
        }

    async def create_connected_node(
        self,
        trip_id: str,
        plan_id: str,
        name: str,
        node_type: str,
        lat: float,
        lng: float,
        created_by: str,
        incoming: list[dict],
        outgoing: list[dict],
        place_id: str | None = None,
        arrival_time: str | None = None,
        departure_time: str | None = None,
    ) -> dict:
        """Create a node with multiple incoming and outgoing connections.

        Validates all referenced nodes exist and checks for cycles before
        writing. Uses a Firestore batch write for atomicity.

        Args:
            incoming: List of dicts with node_id, travel_mode, travel_time_hours,
                      distance_km, route_polyline for edges TO this node.
            outgoing: List of dicts with node_id, travel_mode, travel_time_hours,
                      distance_km, route_polyline for edges FROM this node.

        Raises:
            CycleDetectedError: If the proposed connections would create a cycle.
            LookupError: If a referenced node ID does not exist.
        """
        # Load existing state
        all_edges_raw = await self._edge_repo.list_by_plan(trip_id, plan_id)
        all_nodes_raw = await self._node_repo.list_by_plan(trip_id, plan_id)
        existing_node_ids = {n["id"] for n in all_nodes_raw}

        # Validate all referenced nodes exist
        incoming_ids = [c["node_id"] for c in incoming]
        outgoing_ids = [c["node_id"] for c in outgoing]
        for nid in incoming_ids + outgoing_ids:
            if nid not in existing_node_ids:
                raise LookupError(f"Node {nid} not found")

        # Cycle detection
        new_id = node_id()
        cycle_path = detect_cycle(all_edges_raw, new_id, incoming_ids, outgoing_ids)
        if cycle_path is not None:
            raise CycleDetectedError(cycle_path)

        max_order = max((n.get("order_index", 0) for n in all_nodes_raw), default=0)

        # Resolve arrival time
        if arrival_time:
            resolved_arrival = parse_dt(arrival_time)
        else:
            resolved_arrival = datetime.now(UTC)

        resolved_departure: datetime | None = None
        if departure_time:
            resolved_departure = parse_dt(departure_time)

        new_node = Node(
            id=new_id,
            name=name,
            type=NodeType(node_type),
            lat_lng=LatLng(lat=lat, lng=lng),
            arrival_time=resolved_arrival,
            departure_time=resolved_departure,
            timezone=resolve_timezone(lat, lng),
            place_id=place_id,
            order_index=max_order + 1,
            created_by=created_by,
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )

        new_latlng = {"lat": lat, "lng": lng}

        # Build all edges
        edges_to_create: list[Edge] = []
        edge_latlng_pairs: list[tuple[dict | None, dict | None]] = []

        # Incoming edges: from_node -> new_node
        for conn in incoming:
            from_node = next(
                (n for n in all_nodes_raw if n["id"] == conn["node_id"]), None
            )
            from_ll = None
            if from_node and from_node.get("lat_lng"):
                ll = from_node["lat_lng"]
                from_ll = {"lat": ll.get("lat"), "lng": ll.get("lng")}

            e = Edge(
                id=edge_id(),
                from_node_id=conn["node_id"],
                to_node_id=new_id,
                travel_mode=TravelMode(conn.get("travel_mode", "drive")),
                travel_time_hours=conn.get("travel_time_hours", 1.0),
                distance_km=conn.get("distance_km"),
                route_polyline=conn.get("route_polyline"),
            )
            edges_to_create.append(e)
            edge_latlng_pairs.append((from_ll, new_latlng))

        # Outgoing edges: new_node -> to_node
        for conn in outgoing:
            to_node = next(
                (n for n in all_nodes_raw if n["id"] == conn["node_id"]), None
            )
            to_ll = None
            if to_node and to_node.get("lat_lng"):
                ll = to_node["lat_lng"]
                to_ll = {"lat": ll.get("lat"), "lng": ll.get("lng")}

            e = Edge(
                id=edge_id(),
                from_node_id=new_id,
                to_node_id=conn["node_id"],
                travel_mode=TravelMode(conn.get("travel_mode", "drive")),
                travel_time_hours=conn.get("travel_time_hours", 1.0),
                distance_km=conn.get("distance_km"),
                route_polyline=conn.get("route_polyline"),
            )
            edges_to_create.append(e)
            edge_latlng_pairs.append((new_latlng, to_ll))

        # Atomic batch write: create node + all edges
        batch = self._node_repo._db.batch()

        node_ref = self._node_repo._collection(
            trip_id=trip_id, plan_id=plan_id
        ).document(new_node.id)
        batch.set(node_ref, new_node.model_dump(mode="json"))

        for e in edges_to_create:
            edge_ref = self._edge_repo._collection(
                trip_id=trip_id, plan_id=plan_id
            ).document(e.id)
            batch.set(edge_ref, e.model_dump(mode="json"))

        await batch.commit()

        logger.info(
            "create_connected_node: node=%s, %d incoming, %d outgoing edges",
            new_id, len(incoming), len(outgoing),
        )

        # Fire background polyline fetch for edges missing polylines
        if self._route_service:
            for e, (from_ll, to_ll) in zip(edges_to_create, edge_latlng_pairs):
                if e.route_polyline is None and e.travel_mode != TravelMode.FLIGHT:
                    asyncio.create_task(
                        self._route_service.fetch_and_patch_polyline(
                            trip_id, plan_id, e.id,
                            from_ll, to_ll, str(e.travel_mode), self._edge_repo,
                        )
                    )

        return {
            "node": new_node.model_dump(mode="json"),
            "edges": [e.model_dump(mode="json") for e in edges_to_create],
        }
