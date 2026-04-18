"""DAG service: node/edge CRUD, cycle detection, polyline management, impact previews.

Schedule changes are no longer cascaded imperatively; downstream timings are
derived on read via ``shared.dag.time_inference.enrich_dag_times``. Mutation
endpoints that want to show the user "what will shift" run the enrichment
twice (before/after) and diff the results — see ``update_node_with_impact_preview``.
"""

import asyncio
import logging
import math
from collections import defaultdict
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from shared.repositories.action_repository import ActionRepository
from shared.repositories.edge_repository import EdgeRepository
from shared.repositories.node_repository import NodeRepository
from shared.repositories.plan_repository import PlanRepository
from shared.repositories.trip_repository import TripRepository
from shared.tools.id_gen import edge_id, node_id

if TYPE_CHECKING:
    from shared.services.route_service import RouteService

from shared.dag._internals import parse_dt
from shared.dag.cycle import CycleDetectedError, detect_cycle, would_create_cycle
from shared.dag.time_inference import enrich_dag_times
from shared.models import (
    Edge,
    LatLng,
    Node,
    NodeType,
    NotificationType,
    RelatedEntity,
    TravelMode,
)
from shared.tools.timezone import resolve_timezone

logger = logging.getLogger(__name__)

# Modes not supported by the Routes API — use haversine estimation instead.
_ESTIMATION_SPEEDS_KMH: dict[str, float] = {
    "flight": 800.0,
    "ferry": 40.0,
}


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance between two points in kilometres."""
    R = 6371.0
    dLat = math.radians(lat2 - lat1)
    dLng = math.radians(lng2 - lng1)
    a = (
        math.sin(dLat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dLng / 2) ** 2
    )
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _build_departure_map(nodes: list[dict], edges: list[dict]) -> dict[str, datetime]:
    """Best-effort departure time for each node, for Routes API traffic-aware routing.

    First run the raw graph through `enrich_dag_times` (with default settings)
    to obtain accurate inferred timestamps.
    Fallback chain per node: departure_time → arrival_time → trip start time.
    Returns ``datetime`` objects parsed from the ISO strings that Firestore
    dict documents carry (``enrich_dag_times`` operates on those dicts).
    """
    enriched_nodes = enrich_dag_times(nodes, edges)

    result: dict[str, datetime] = {}
    trip_start: datetime | None = None

    in_degree_ids: set[str] = {e["to_node_id"] for e in edges}
    for n in enriched_nodes:
        if n["id"] not in in_degree_ids and n.get("departure_time"):
            trip_start = datetime.fromisoformat(n["departure_time"])
            break
    if not trip_start:
        for n in enriched_nodes:
            dt = n.get("departure_time") or n.get("arrival_time")
            if dt:
                trip_start = datetime.fromisoformat(dt)
                break

    for n in enriched_nodes:
        dt = n.get("departure_time") or n.get("arrival_time")
        if dt:
            result[n["id"]] = datetime.fromisoformat(dt)
        elif trip_start:
            result[n["id"]] = trip_start

    return result


class DAGService:
    def __init__(
        self,
        trip_repo: TripRepository,
        plan_repo: PlanRepository,
        node_repo: NodeRepository,
        edge_repo: EdgeRepository,
        route_service: "RouteService | None" = None,
        action_repo: ActionRepository | None = None,
    ):
        self._trip_repo = trip_repo
        self._plan_repo = plan_repo
        self._node_repo = node_repo
        self._edge_repo = edge_repo
        self._route_service = route_service
        self._action_repo = action_repo
        # Holds strong references to background polyline tasks so they don't
        # get collected mid-flight. Tasks remove themselves on completion.
        self._background_tasks: set[asyncio.Task] = set()

    def _spawn_background(self, coro) -> asyncio.Task:
        """Fire-and-forget helper that keeps a strong reference to the task
        until it completes, so the asyncio event loop can't drop it early.
        """
        task = asyncio.create_task(coro)
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)
        return task

    async def _find_existing_edge(
        self,
        trip_id: str,
        plan_id: str,
        from_node_id: str,
        to_node_id: str,
        existing_edges: list[dict] | None = None,
    ) -> dict | None:
        """Return an existing edge between the two nodes, or None.

        If `existing_edges` is provided, scan it instead of re-fetching the
        full edge list — lets callers that already have the list avoid the
        redundant Firestore read.
        """
        edges = (
            existing_edges
            if existing_edges is not None
            else await self._edge_repo.list_by_plan(trip_id, plan_id)
        )
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
        existing_edges: list[dict] | None = None,
        departure_time: datetime | None = None,
        from_name: str | None = None,
        to_name: str | None = None,
        from_place_id: str | None = None,
        to_place_id: str | None = None,
    ) -> dict:
        """Create an edge only if no edge exists between the same from/to pair.

        Returns the existing edge dict if a duplicate is found, otherwise
        creates the new edge and returns its dict.

        If the new edge has no route_polyline, is not a flight, and a
        RouteService is available, fires a background task to fetch and
        patch the polyline.

        Pass `existing_edges` when the caller already fetched the edge list
        (e.g. for a cycle check) so we don't re-read the whole collection.
        """
        existing = await self._find_existing_edge(
            trip_id, plan_id, edge.from_node_id, edge.to_node_id,
            existing_edges=existing_edges,
        )
        if existing:
            return existing
        await self._edge_repo.create_edge(trip_id, plan_id, edge)
        if (
            edge.route_polyline is None
            and edge.travel_mode != TravelMode.FERRY
            and self._route_service is not None
        ):
            self._spawn_background(
                self._route_service.fetch_and_patch_polyline(
                    trip_id=trip_id,
                    plan_id=plan_id,
                    edge_id=edge.id,
                    from_latlng=from_latlng,
                    to_latlng=to_latlng,
                    travel_mode=str(edge.travel_mode),
                    edge_repo=self._edge_repo,
                    departure_time=departure_time,
                    from_name=from_name,
                    to_name=to_name,
                    from_place_id=from_place_id,
                    to_place_id=to_place_id,
                )
            )
        return edge.model_dump(mode="json")

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

    async def get_edge(
        self, trip_id: str, plan_id: str, edge_id: str
    ) -> dict | None:
        """Fetch a single edge as a dict, or None if it does not exist."""
        return await self._edge_repo.get(
            edge_id, trip_id=trip_id, plan_id=plan_id,
        )

    async def get_node_name(
        self, trip_id: str, plan_id: str, node_id: str, default: str | None = None
    ) -> str:
        """Return a node's display name, or `default` (or the node_id) if missing."""
        data = await self._node_repo.get(
            node_id, trip_id=trip_id, plan_id=plan_id,
        )
        if data is None:
            return default if default is not None else node_id
        return data.get("name") or (default if default is not None else node_id)

    async def set_active_plan(self, trip_id: str, plan_id: str) -> None:
        """Set the trip's active plan pointer and bump updated_at."""
        await self._trip_repo.update_trip(trip_id, {
            "active_plan_id": plan_id,
            "updated_at": datetime.now(UTC).isoformat(),
        })

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
        duration_minutes: int | None = None,
        connect_before_node_id: str | None = None,
        route_polyline: str | None = None,
    ) -> dict:
        """Create a new node, optionally connecting it to an existing node.

        All Firestore mutations (node create + edge create) are committed in a
        single atomic batch so that frontend ``onSnapshot`` listeners see one
        consistent update instead of a transient node-without-edge state.

        Timing fields are all optional. Flex nodes can be created with only a
        duration (or nothing at all) — the read-time enrichment pass fills in
        propagated times when the graph has a concrete anchor upstream.
        """
        source = None
        if connect_after_node_id:
            source = await self._node_repo.get_node_or_raise(
                trip_id, plan_id, connect_after_node_id
            )

        before_node = None
        if connect_before_node_id:
            before_node = await self._node_repo.get_node_or_raise(
                trip_id, plan_id, connect_before_node_id
            )

        resolved_arrival = parse_dt(arrival_time) if arrival_time else None
        resolved_departure = parse_dt(departure_time) if departure_time else None

        new_node = Node(
            id=node_id(),
            name=name,
            type=NodeType(node_type),
            lat_lng=LatLng(lat=lat, lng=lng),
            arrival_time=resolved_arrival,
            departure_time=resolved_departure,
            duration_minutes=duration_minutes,
            timezone=resolve_timezone(lat, lng),
            place_id=place_id,
            created_by=created_by,
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )

        new_latlng = {"lat": lat, "lng": lng}

        # --- Compute phase (reads only, no writes) ---
        edge_to_create: Edge | None = None
        edge_dict: dict | None = None
        polyline_job: dict | None = None

        if connect_after_node_id:
            source_latlng: dict | None = None
            if source is not None and source.lat_lng is not None:
                ll = source.lat_lng
                source_latlng = {"lat": ll.lat, "lng": ll.lng}

            existing_edges = await self._edge_repo.list_by_plan(trip_id, plan_id)
            existing = await self._find_existing_edge(
                trip_id, plan_id, connect_after_node_id, new_node.id,
                existing_edges=existing_edges,
            )
            if existing:
                edge_dict = existing
            else:
                edge_to_create = Edge(
                    id=edge_id(),
                    from_node_id=connect_after_node_id,
                    to_node_id=new_node.id,
                    travel_mode=TravelMode(travel_mode),
                    travel_time_hours=travel_time_hours,
                    distance_km=distance_km,
                    route_polyline=route_polyline,
                )
                edge_dict = edge_to_create.model_dump(mode="json")

                if (
                    route_polyline is None
                    and TravelMode(travel_mode) not in (TravelMode.FLIGHT, TravelMode.FERRY)
                    and self._route_service is not None
                ):
                    dep = (source.departure_time or source.arrival_time) if source else None
                    if dep is None:
                        all_nodes = await self._node_repo.list_by_plan(trip_id, plan_id)
                        dep = _build_departure_map(all_nodes, existing_edges).get(connect_after_node_id)
                    polyline_job = {
                        "edge_id": edge_to_create.id,
                        "from_latlng": source_latlng,
                        "to_latlng": new_latlng,
                        "travel_mode": str(edge_to_create.travel_mode),
                        "departure_time": dep,
                        "from_name": source.name if source else None,
                        "to_name": name,
                        "from_place_id": source.place_id if source else None,
                        "to_place_id": place_id,
                    }

        elif connect_before_node_id:
            before_latlng: dict | None = None
            if before_node is not None and before_node.lat_lng is not None:
                bl = before_node.lat_lng
                before_latlng = {"lat": bl.lat, "lng": bl.lng}

            existing_edges = await self._edge_repo.list_by_plan(trip_id, plan_id)
            existing = await self._find_existing_edge(
                trip_id, plan_id, new_node.id, connect_before_node_id,
                existing_edges=existing_edges,
            )
            if existing:
                edge_dict = existing
            else:
                edge_to_create = Edge(
                    id=edge_id(),
                    from_node_id=new_node.id,
                    to_node_id=connect_before_node_id,
                    travel_mode=TravelMode(travel_mode),
                    travel_time_hours=travel_time_hours,
                    distance_km=distance_km,
                    route_polyline=route_polyline,
                )
                edge_dict = edge_to_create.model_dump(mode="json")

                if (
                    route_polyline is None
                    and TravelMode(travel_mode) not in (TravelMode.FLIGHT, TravelMode.FERRY)
                    and self._route_service is not None
                ):
                    dep = resolved_departure or resolved_arrival
                    if dep is None:
                        # New node not yet committed — can't look it up.
                        # Fall back to trip root departure via the map.
                        all_nodes = await self._node_repo.list_by_plan(trip_id, plan_id)
                        dep_map = _build_departure_map(all_nodes, existing_edges)
                        # Any timed node's departure is a useful fallback;
                        # _build_departure_map already resolves trip_start
                        # as the fallback for timeless nodes, so grab the
                        # before-node's entry (which is either its own time
                        # or the trip root's).
                        dep = dep_map.get(connect_before_node_id) or next(
                            iter(dep_map.values()), None
                        )
                    polyline_job = {
                        "edge_id": edge_to_create.id,
                        "from_latlng": new_latlng,
                        "to_latlng": before_latlng,
                        "travel_mode": str(edge_to_create.travel_mode),
                        "departure_time": dep,
                        "from_name": name,
                        "to_name": before_node.name,
                        "from_place_id": place_id,
                        "to_place_id": before_node.place_id,
                    }

        # --- Atomic batch write ---
        db = self._node_repo._db
        node_col = self._node_repo._collection(trip_id=trip_id, plan_id=plan_id)
        edge_col = self._edge_repo._collection(trip_id=trip_id, plan_id=plan_id)

        batch = db.batch()
        batch.set(node_col.document(new_node.id), new_node.model_dump(mode="json"))
        if edge_to_create is not None:
            batch.set(edge_col.document(edge_to_create.id), edge_to_create.model_dump(mode="json"))
        await batch.commit()

        # --- Post-commit: fire background polyline fetch ---
        if polyline_job is not None:
            self._spawn_background(
                self._route_service.fetch_and_patch_polyline(
                    trip_id=trip_id,
                    plan_id=plan_id,
                    edge_id=polyline_job["edge_id"],
                    from_latlng=polyline_job["from_latlng"],
                    to_latlng=polyline_job["to_latlng"],
                    travel_mode=polyline_job["travel_mode"],
                    edge_repo=self._edge_repo,
                    departure_time=polyline_job["departure_time"],
                    from_name=polyline_job["from_name"],
                    to_name=polyline_job["to_name"],
                    from_place_id=polyline_job.get("from_place_id"),
                    to_place_id=polyline_job.get("to_place_id"),
                )
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

        All Firestore mutations (edge deletes, reconnection edge creates,
        action deletes, node delete) are committed in a single atomic batch
        so that frontend ``onSnapshot`` listeners see one consistent update
        instead of transient intermediate states that trigger false
        divergence in the DivergenceResolver.

        Reconnection cases:
        - 1 incoming, 1 outgoing: reconnect predecessor -> successor.
        - N incoming, 1 outgoing: reconnect each predecessor -> successor
          (preserves fan-in / merge topology).
        - 1 incoming, N outgoing: reconnect predecessor -> each successor
          (preserves fan-out / divergence topology).
        - N incoming, M outgoing (N>1, M>1): ambiguous, no reconnection.
        """
        all_edges = await self._edge_repo.list_by_plan(trip_id, plan_id)

        incoming = [e for e in all_edges if e["to_node_id"] == node_id]
        outgoing = [e for e in all_edges if e["from_node_id"] == node_id]

        # --- Compute phase (reads only) ---

        # Determine which reconnection edges to create.
        reconnected_edges: list[dict] = []
        new_edges_to_create: list[Edge] = []
        polyline_jobs: list[dict] = []  # post-commit background fetches

        can_reconnect = (
            len(incoming) >= 1 and len(outgoing) >= 1
            and (len(incoming) == 1 or len(outgoing) == 1)
        )
        if can_reconnect:
            all_nodes = await self._node_repo.list_by_plan(trip_id, plan_id)
            node_by_id = {n["id"]: n for n in all_nodes}

            remaining_edges = [
                e for e in all_edges
                if e["id"] not in {ie["id"] for ie in incoming + outgoing}
            ]
            departure_map = _build_departure_map(all_nodes, remaining_edges)

            for inc in incoming:
                for out in outgoing:
                    from_id = inc["from_node_id"]
                    to_id = out["to_node_id"]
                    from_node = node_by_id.get(from_id)
                    to_node = node_by_id.get(to_id)

                    # Check for existing duplicate (read-only).
                    existing = await self._find_existing_edge(
                        trip_id, plan_id, from_id, to_id,
                        existing_edges=remaining_edges,
                    )
                    if existing:
                        reconnected_edges.append(existing)
                        continue

                    from_latlng = (
                        from_node.get("lat_lng") if from_node else None
                    )
                    to_latlng = (
                        to_node.get("lat_lng") if to_node else None
                    )
                    dep_time = departure_map.get(from_id)

                    new_edge = Edge(
                        id=edge_id(),
                        from_node_id=from_id,
                        to_node_id=to_id,
                        travel_mode=TravelMode(
                            inc.get("travel_mode", "drive")
                        ),
                        travel_time_hours=(
                            inc.get("travel_time_hours", 0)
                            + out.get("travel_time_hours", 0)
                        ),
                        distance_km=None,
                    )
                    new_edges_to_create.append(new_edge)
                    reconnected_edges.append(new_edge.model_dump(mode="json"))

                    # Queue background polyline fetch for after commit.
                    if (
                        new_edge.travel_mode
                        not in (TravelMode.FLIGHT, TravelMode.FERRY)
                        and self._route_service is not None
                    ):
                        polyline_jobs.append({
                            "edge_id": new_edge.id,
                            "from_latlng": from_latlng,
                            "to_latlng": to_latlng,
                            "travel_mode": str(new_edge.travel_mode),
                            "departure_time": dep_time,
                            "from_name": (
                                from_node.get("name") if from_node else None
                            ),
                            "to_name": (
                                to_node.get("name") if to_node else None
                            ),
                            "from_place_id": (
                                from_node.get("place_id") if from_node else None
                            ),
                            "to_place_id": (
                                to_node.get("place_id") if to_node else None
                            ),
                        })

        # K=1 reconnection (linear A→X→B becomes A→B): fetch the new edge's
        # route synchronously so the batch writes a fully-populated edge doc.
        # Avoids the post-commit background patch that would otherwise show a
        # missing polyline + shimmer flash for ~1-3s after the delete returns.
        # K>1 stays backgrounded — multiple synchronous Routes API calls would
        # blow up tail latency on the delete handler.
        if (
            len(new_edges_to_create) == 1
            and len(polyline_jobs) == 1
            and self._route_service is not None
        ):
            sync_edge = new_edges_to_create[0]
            sync_job = polyline_jobs[0]
            try:
                route_data = await self._route_service.get_route_data(
                    sync_job["from_latlng"],
                    sync_job["to_latlng"],
                    sync_job["travel_mode"],
                    sync_job["departure_time"],
                    from_name=sync_job["from_name"],
                    to_name=sync_job["to_name"],
                    from_place_id=sync_job.get("from_place_id"),
                    to_place_id=sync_job.get("to_place_id"),
                )
            except Exception:
                logger.warning(
                    "K=1 sync polyline fetch failed for edge %s; "
                    "falling back to background",
                    sync_edge.id,
                    exc_info=True,
                )
                route_data = None

            if route_data is not None:
                if route_data.polyline:
                    sync_edge.route_polyline = route_data.polyline
                if route_data.travel_time_hours is not None:
                    sync_edge.travel_time_hours = route_data.travel_time_hours
                if route_data.distance_km is not None:
                    sync_edge.distance_km = route_data.distance_km
                # Reflect the populated fields in the response payload.
                reconnected_edges[-1] = sync_edge.model_dump(mode="json")
                # Skip the now-redundant background fetch.
                polyline_jobs.clear()

        # Collect action refs for subcollection cleanup.
        action_refs = []
        if self._action_repo is not None:
            actions = await self._action_repo.list_by_node(
                trip_id, plan_id, node_id
            )
            action_col = self._action_repo._collection(
                trip_id=trip_id, plan_id=plan_id, node_id=node_id
            )
            action_refs = [action_col.document(a["id"]) for a in actions]

        # --- Atomic batch write ---
        db = self._node_repo._db
        edge_col = self._edge_repo._collection(
            trip_id=trip_id, plan_id=plan_id
        )
        node_col = self._node_repo._collection(
            trip_id=trip_id, plan_id=plan_id
        )

        # Build all write ops then chunk into 500-op batches.
        ops: list[tuple[str, ...]] = []  # ("delete", ref) or ("set", ref, data)
        for e in incoming + outgoing:
            ops.append(("delete", edge_col.document(e["id"])))
        for new_edge in new_edges_to_create:
            ops.append((
                "set",
                edge_col.document(new_edge.id),
                new_edge.model_dump(mode="json"),
            ))
        for ref in action_refs:
            ops.append(("delete", ref))
        ops.append(("delete", node_col.document(node_id)))

        batch_size = 500
        for i in range(0, len(ops), batch_size):
            batch = db.batch()
            for op in ops[i : i + batch_size]:
                if op[0] == "delete":
                    batch.delete(op[1])
                else:
                    batch.set(op[1], op[2])
            await batch.commit()

        # --- Post-commit: fire background polyline fetches ---
        for job in polyline_jobs:
            self._spawn_background(
                self._route_service.fetch_and_patch_polyline(
                    trip_id=trip_id,
                    plan_id=plan_id,
                    edge_id=job["edge_id"],
                    from_latlng=job["from_latlng"],
                    to_latlng=job["to_latlng"],
                    travel_mode=job["travel_mode"],
                    edge_repo=self._edge_repo,
                    departure_time=job["departure_time"],
                    from_name=job["from_name"],
                    to_name=job["to_name"],
                    from_place_id=job.get("from_place_id"),
                    to_place_id=job.get("to_place_id"),
                )
            )

        return {
            "deleted_node_id": node_id,
            "deleted_edge_count": len(incoming) + len(outgoing),
            "reconnected_edge": reconnected_edges[0] if reconnected_edges else None,
            "reconnected_edges": reconnected_edges,
            "participant_ids_cleaned": 0,
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
        duration_minutes: int | None = None,
        route_polyline: str | None = None,
    ) -> dict:
        """Create a new node branching off from an existing node.

        All Firestore mutations (node create + branch edge + optional merge
        edge) are committed in a single atomic batch so that frontend
        ``onSnapshot`` listeners see one consistent update.

        Timing fields are all optional; enrichment fills propagated values
        on read.
        """
        source = await self._node_repo.get_node_or_raise(trip_id, plan_id, from_node_id)

        merge_target = None
        if connect_to_node_id:
            merge_target = await self._node_repo.get_node_or_raise(
                trip_id, plan_id, connect_to_node_id
            )

        resolved_arrival = parse_dt(arrival_time) if arrival_time else None
        resolved_departure = parse_dt(departure_time) if departure_time else None

        new_node = Node(
            id=node_id(),
            name=name,
            type=NodeType(node_type),
            lat_lng=LatLng(lat=lat, lng=lng),
            arrival_time=resolved_arrival,
            departure_time=resolved_departure,
            duration_minutes=duration_minutes,
            timezone=resolve_timezone(lat, lng),
            place_id=place_id,
            created_by=created_by,
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )

        new_latlng = {"lat": lat, "lng": lng}

        source_latlng: dict | None = None
        if source.lat_lng is not None:
            ll = source.lat_lng
            source_latlng = {"lat": ll.lat, "lng": ll.lng}

        # --- Compute phase (reads only, no writes) ---
        existing_edges = await self._edge_repo.list_by_plan(trip_id, plan_id)

        dep_branch: datetime | None = source.departure_time or source.arrival_time
        dep_merge: datetime | None = resolved_departure or resolved_arrival
        if dep_branch is None or (connect_to_node_id and dep_merge is None):
            all_nodes = await self._node_repo.list_by_plan(trip_id, plan_id)
            dep_map = _build_departure_map(all_nodes, existing_edges)
            if dep_branch is None:
                dep_branch = dep_map.get(from_node_id)
            if dep_merge is None:
                # New node not yet committed — fall back to source's
                # departure or trip root via the map.
                dep_merge = dep_map.get(from_node_id) or next(
                    iter(dep_map.values()), None
                )

        # Branch edge: source -> new_node
        branch_edge_to_create: Edge | None = None
        branch_edge_dict: dict | None = None
        branch_polyline_job: dict | None = None

        existing_branch = await self._find_existing_edge(
            trip_id, plan_id, from_node_id, new_node.id,
            existing_edges=existing_edges,
        )
        if existing_branch:
            branch_edge_dict = existing_branch
        else:
            branch_edge_to_create = Edge(
                id=edge_id(),
                from_node_id=from_node_id,
                to_node_id=new_node.id,
                travel_mode=TravelMode(travel_mode),
                travel_time_hours=travel_time_hours,
                distance_km=distance_km,
                route_polyline=route_polyline,
            )
            branch_edge_dict = branch_edge_to_create.model_dump(mode="json")

            if (
                route_polyline is None
                and TravelMode(travel_mode) not in (TravelMode.FLIGHT, TravelMode.FERRY)
                and self._route_service is not None
            ):
                branch_polyline_job = {
                    "edge_id": branch_edge_to_create.id,
                    "from_latlng": source_latlng,
                    "to_latlng": new_latlng,
                    "travel_mode": str(branch_edge_to_create.travel_mode),
                    "departure_time": dep_branch,
                    "from_name": source.name,
                    "to_name": name,
                    "from_place_id": source.place_id,
                    "to_place_id": place_id,
                }

        # Merge edge: new_node -> merge_target (optional)
        merge_edge_to_create: Edge | None = None
        merge_edge_dict: dict | None = None
        merge_polyline_job: dict | None = None

        if connect_to_node_id and merge_target is not None:
            merge_target_latlng: dict | None = None
            if merge_target.lat_lng is not None:
                mt_ll = merge_target.lat_lng
                merge_target_latlng = {"lat": mt_ll.lat, "lng": mt_ll.lng}

            existing_merge = await self._find_existing_edge(
                trip_id, plan_id, new_node.id, connect_to_node_id,
                existing_edges=existing_edges,
            )
            if existing_merge:
                merge_edge_dict = existing_merge
            else:
                merge_edge_to_create = Edge(
                    id=edge_id(),
                    from_node_id=new_node.id,
                    to_node_id=connect_to_node_id,
                    travel_mode=TravelMode(travel_mode),
                    travel_time_hours=travel_time_hours,
                    distance_km=distance_km,
                    route_polyline=None,
                )
                merge_edge_dict = merge_edge_to_create.model_dump(mode="json")

                if (
                    TravelMode(travel_mode) not in (TravelMode.FLIGHT, TravelMode.FERRY)
                    and self._route_service is not None
                ):
                    merge_polyline_job = {
                        "edge_id": merge_edge_to_create.id,
                        "from_latlng": new_latlng,
                        "to_latlng": merge_target_latlng,
                        "travel_mode": str(merge_edge_to_create.travel_mode),
                        "departure_time": dep_merge,
                        "from_name": name,
                        "to_name": merge_target.name,
                        "from_place_id": place_id,
                        "to_place_id": merge_target.place_id,
                    }

        # --- Atomic batch write ---
        db = self._node_repo._db
        node_col = self._node_repo._collection(trip_id=trip_id, plan_id=plan_id)
        edge_col = self._edge_repo._collection(trip_id=trip_id, plan_id=plan_id)

        batch = db.batch()
        batch.set(node_col.document(new_node.id), new_node.model_dump(mode="json"))
        if branch_edge_to_create is not None:
            batch.set(edge_col.document(branch_edge_to_create.id), branch_edge_to_create.model_dump(mode="json"))
        if merge_edge_to_create is not None:
            batch.set(edge_col.document(merge_edge_to_create.id), merge_edge_to_create.model_dump(mode="json"))
        await batch.commit()

        # --- Post-commit: fire background polyline fetches ---
        for job in [branch_polyline_job, merge_polyline_job]:
            if job is not None:
                self._spawn_background(
                    self._route_service.fetch_and_patch_polyline(
                        trip_id=trip_id,
                        plan_id=plan_id,
                        edge_id=job["edge_id"],
                        from_latlng=job["from_latlng"],
                        to_latlng=job["to_latlng"],
                        travel_mode=job["travel_mode"],
                        edge_repo=self._edge_repo,
                        departure_time=job["departure_time"],
                        from_name=job["from_name"],
                        to_name=job["to_name"],
                        from_place_id=job.get("from_place_id"),
                        to_place_id=job.get("to_place_id"),
                    )
                )

        return {
            "node": new_node.model_dump(mode="json"),
            "edge": branch_edge_dict,
            "merge_edge": merge_edge_dict,
        }

    async def update_node_only(
        self,
        trip_id: str,
        plan_id: str,
        node_id: str,
        updates: dict[str, Any],
    ) -> dict:
        """Update a single node. Does not cascade schedule changes downstream
        and does not touch connected edges.

        Used by the MCP server where external LLMs expect a targeted update to
        be targeted. If lat_lng changes, the node's timezone is re-resolved;
        no polylines are recomputed and no downstream arrival/departure times
        are adjusted.

        Returns the updated node dict.
        """
        node = await self._node_repo.get_node_or_raise(trip_id, plan_id, node_id)
        node_dict = node.model_dump(mode="json")

        for key, value in updates.items():
            node_dict[key] = value
        node_dict["updated_at"] = datetime.now(UTC).isoformat()

        # Re-resolve timezone if location changed
        if "lat_lng" in updates:
            lat_lng = node_dict.get("lat_lng", {})
            lat = lat_lng.get("lat") if isinstance(lat_lng, dict) else getattr(lat_lng, "lat", None)
            lng = lat_lng.get("lng") if isinstance(lat_lng, dict) else getattr(lat_lng, "lng", None)
            if lat is not None and lng is not None:
                node_dict["timezone"] = resolve_timezone(lat, lng)

        await self._node_repo.update_node(trip_id, plan_id, node_id, node_dict)

        # Recalculate polylines for connected edges when location actually changed
        if "lat_lng" in updates:
            old_lat = node.lat_lng.lat if node.lat_lng else None
            old_lng = node.lat_lng.lng if node.lat_lng else None
            new_lat_lng = updates["lat_lng"]
            new_lat = new_lat_lng.get("lat") if isinstance(new_lat_lng, dict) else getattr(new_lat_lng, "lat", None)
            new_lng = new_lat_lng.get("lng") if isinstance(new_lat_lng, dict) else getattr(new_lat_lng, "lng", None)
            if new_lat != old_lat or new_lng != old_lng:
                await self._recalculate_connected_polylines(
                    trip_id, plan_id, node_id, {"lat": new_lat, "lng": new_lng}
                )

        return node_dict

    async def update_node_with_impact_preview(
        self,
        trip_id: str,
        plan_id: str,
        node_id: str,
        updates: dict[str, Any],
        client_updated_at: str | None = None,
        edited_by: str | None = None,
        notification_service=None,
        trip_settings: dict | None = None,
    ) -> dict:
        """Update a node and return an impact preview diffed from enrichment.

        Runs ``enrich_dag_times`` twice — once over the pre-edit graph and once
        over the post-edit graph — and reports the delta as:
        - ``estimated_shifts``: downstream nodes whose enriched arrival moved
        - ``new_conflicts``: nodes that picked up a ``timing_conflict`` flag
        - ``new_overnight_holds``: nodes that newly trip the night / max-drive rule

        If ``client_updated_at`` is provided, compares with the node's current
        ``updated_at``. If they differ (another user edited concurrently),
        sends an edit_conflict notification. Last-write-wins.
        """
        node = await self._node_repo.get_node_or_raise(trip_id, plan_id, node_id)
        node_dict = node.model_dump(mode="json")

        # Snapshot the pre-edit graph so we can diff enrichment later. The
        # node under edit needs to be swapped out for its in-memory copy so
        # both runs see a consistent view.
        all_nodes_before = await self._node_repo.list_by_plan(trip_id, plan_id)
        all_edges = await self._edge_repo.list_by_plan(trip_id, plan_id)

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

        if "lat_lng" in updates:
            lat_lng = node_dict.get("lat_lng", {})
            lat = lat_lng.get("lat") if isinstance(lat_lng, dict) else getattr(lat_lng, "lat", None)
            lng = lat_lng.get("lng") if isinstance(lat_lng, dict) else getattr(lat_lng, "lng", None)
            if lat is not None and lng is not None:
                node_dict["timezone"] = resolve_timezone(lat, lng)

        await self._node_repo.update_node(trip_id, plan_id, node_id, node_dict)

        # Build the post-update snapshot once and reuse it for both the
        # polyline recompute and the impact-preview diff. Avoids the two
        # extra Firestore reads (nodes + edges) that the recompute used to
        # do internally.
        all_nodes_after = [
            dict(node_dict) if n["id"] == node_id else n
            for n in all_nodes_before
        ]

        if "lat_lng" in updates:
            old_lat = node.lat_lng.lat if node.lat_lng else None
            old_lng = node.lat_lng.lng if node.lat_lng else None
            new_lat = updates["lat_lng"].get("lat")
            new_lng = updates["lat_lng"].get("lng")
            if new_lat != old_lat or new_lng != old_lng:
                await self._recalculate_connected_polylines(
                    trip_id, plan_id, node_id, {"lat": new_lat, "lng": new_lng},
                    existing_nodes=all_nodes_after,
                    existing_edges=all_edges,
                )

        impact_preview = self._diff_enrichment(
            all_nodes_before, all_nodes_after, all_edges, trip_settings or {}
        )

        return {
            "node": node_dict,
            "impact_preview": impact_preview,
            "conflict": conflict,
        }

    @staticmethod
    def _diff_enrichment(
        nodes_before: list[dict],
        nodes_after: list[dict],
        edges: list[dict],
        trip_settings: dict,
    ) -> dict:
        """Run enrichment over both graphs and surface what changed.

        Returns a dict with three lists keyed by affected node id. Uses the
        same shape the frontend edit sheet consumes so inline preview and
        post-save response stay in sync.
        """
        before = {n["id"]: n for n in enrich_dag_times(nodes_before, edges, trip_settings)}
        after = {n["id"]: n for n in enrich_dag_times(nodes_after, edges, trip_settings)}

        estimated_shifts: list[dict] = []
        new_conflicts: list[dict] = []
        new_overnight_holds: list[dict] = []

        for node_id_, after_node in after.items():
            before_node = before.get(node_id_)
            if before_node is None:
                continue

            arrival_changed = parse_dt(after_node.get("arrival_time")) != parse_dt(
                before_node.get("arrival_time")
            )
            departure_changed = parse_dt(after_node.get("departure_time")) != parse_dt(
                before_node.get("departure_time")
            )
            if arrival_changed or departure_changed:
                estimated_shifts.append({
                    "id": node_id_,
                    "name": after_node.get("name", ""),
                    "old_arrival": before_node.get("arrival_time"),
                    "new_arrival": after_node.get("arrival_time"),
                    "old_departure": before_node.get("departure_time"),
                    "new_departure": after_node.get("departure_time"),
                })

            after_conflict = after_node.get("timing_conflict")
            if after_conflict and after_conflict != before_node.get("timing_conflict"):
                new_conflicts.append({
                    "id": node_id_,
                    "name": after_node.get("name", ""),
                    "message": after_conflict,
                })

            if after_node.get("hold_reason") and not before_node.get("hold_reason"):
                new_overnight_holds.append({
                    "id": node_id_,
                    "name": after_node.get("name", ""),
                    "reason": after_node.get("hold_reason"),
                })

        return {
            "estimated_shifts": estimated_shifts,
            "new_conflicts": new_conflicts,
            "new_overnight_holds": new_overnight_holds,
        }

    async def _recalculate_connected_polylines(
        self,
        trip_id: str,
        plan_id: str,
        node_id: str,
        new_latlng: dict,
        existing_nodes: list[dict] | None = None,
        existing_edges: list[dict] | None = None,
    ) -> None:
        """Fire background polyline recalculation for all edges connected to a node.

        Called when a node's location changes. Skips flight/ferry edges.

        ``existing_nodes`` / ``existing_edges`` let callers that already
        loaded the plan snapshot (e.g. ``update_node_with_impact_preview``)
        skip the redundant Firestore reads.
        """
        if not self._route_service:
            return

        all_edges = (
            existing_edges
            if existing_edges is not None
            else await self._edge_repo.list_by_plan(trip_id, plan_id)
        )
        connected = [
            e for e in all_edges
            if e["from_node_id"] == node_id or e["to_node_id"] == node_id
        ]
        if not connected:
            return

        # Batch-fetch every distinct other-endpoint node in a single
        # list_by_plan call, then look up lat/lng from the in-memory map.
        # Previously this did one get_node_or_raise per connected edge.
        all_nodes = (
            existing_nodes
            if existing_nodes is not None
            else await self._node_repo.list_by_plan(trip_id, plan_id)
        )
        node_latlng_by_id: dict[str, dict | None] = {}
        node_name_by_id: dict[str, str | None] = {}
        node_place_id_by_id: dict[str, str | None] = {}
        for n in all_nodes:
            ll = n.get("lat_lng")
            if ll and ll.get("lat") is not None and ll.get("lng") is not None:
                node_latlng_by_id[n["id"]] = {"lat": ll["lat"], "lng": ll["lng"]}
            else:
                node_latlng_by_id[n["id"]] = None
            node_name_by_id[n["id"]] = n.get("name")
            node_place_id_by_id[n["id"]] = n.get("place_id")

        departure_by_id = _build_departure_map(all_nodes, all_edges)

        queued = 0
        for edge_dict in connected:
            travel_mode = edge_dict.get("travel_mode", "drive")
            if travel_mode == "ferry":
                continue

            from_node_id = edge_dict["from_node_id"]
            if from_node_id == node_id:
                from_latlng = new_latlng
                to_latlng = node_latlng_by_id.get(edge_dict["to_node_id"])
            else:
                to_latlng = new_latlng
                from_latlng = node_latlng_by_id.get(from_node_id)

            self._spawn_background(
                self._route_service.fetch_and_patch_polyline(
                    trip_id=trip_id,
                    plan_id=plan_id,
                    edge_id=edge_dict["id"],
                    from_latlng=from_latlng,
                    to_latlng=to_latlng,
                    travel_mode=travel_mode,
                    edge_repo=self._edge_repo,
                    departure_time=departure_by_id.get(from_node_id),
                    from_name=node_name_by_id.get(edge_dict["from_node_id"]),
                    to_name=node_name_by_id.get(edge_dict["to_node_id"]),
                    from_place_id=node_place_id_by_id.get(edge_dict["from_node_id"]),
                    to_place_id=node_place_id_by_id.get(edge_dict["to_node_id"]),
                )
            )
            queued += 1

        logger.debug(
            "Queued polyline recalculation for %d edges connected to node %s",
            queued, node_id,
        )

    async def cleanup_stale_participant_ids(
        self, trip_id: str, plan_id: str
    ) -> int:
        """Remove participant_ids from all nodes when the DAG is linear.

        A DAG is linear when it has exactly one root AND no node has
        out-degree > 1. Multi-root DAGs use participant_ids on root nodes
        to track which user starts where, so cleanup must not fire.
        Returns the number of nodes cleaned.
        """
        all_edges = await self._edge_repo.list_by_plan(trip_id, plan_id)
        out_degree: dict[str, int] = defaultdict(int)
        in_degree_node_ids: set[str] = set()
        for e in all_edges:
            out_degree[e["from_node_id"]] += 1
            in_degree_node_ids.add(e["to_node_id"])

        has_divergence = any(deg > 1 for deg in out_degree.values())
        if has_divergence:
            return 0

        all_nodes = await self._node_repo.list_by_plan(trip_id, plan_id)

        root_count = sum(1 for n in all_nodes if n["id"] not in in_degree_node_ids)
        if root_count > 1:
            return 0

        to_clean = [n for n in all_nodes if n.get("participant_ids")]
        if not to_clean:
            return 0

        node_col = self._node_repo._collection(trip_id=trip_id, plan_id=plan_id)
        db = self._node_repo._db
        batch_size = 500
        for i in range(0, len(to_clean), batch_size):
            batch = db.batch()
            for node_dict in to_clean[i : i + batch_size]:
                batch.update(
                    node_col.document(node_dict["id"]),
                    {"participant_ids": None},
                )
            await batch.commit()
        return len(to_clean)

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
        notes: str | None = None,
    ) -> dict:
        """Create a standalone edge between two existing nodes.

        When route data (travel_time_hours, distance_km, route_polyline) is not
        provided, fetches it synchronously from the Routes API before writing.
        """
        from_node = await self._node_repo.get_node_or_raise(trip_id, plan_id, from_node_id)
        to_node = await self._node_repo.get_node_or_raise(trip_id, plan_id, to_node_id)

        # Cycle check — reject before expensive route data fetch. The same
        # edge list is reused for the duplicate-edge check below so we only
        # hit Firestore once.
        existing_edges = await self._edge_repo.list_by_plan(trip_id, plan_id)
        cycle_path = would_create_cycle(from_node_id, to_node_id, existing_edges)
        if cycle_path:
            raise CycleDetectedError(cycle_path)

        from_latlng: dict | None = None
        if from_node.lat_lng is not None:
            ll = from_node.lat_lng
            from_latlng = {"lat": ll.lat, "lng": ll.lng}

        to_latlng: dict | None = None
        if to_node.lat_lng is not None:
            ll = to_node.lat_lng
            to_latlng = {"lat": ll.lat, "lng": ll.lng}

        # Best-effort departure time for the Routes API — same fallback
        # chain as _build_departure_map so flex nodes without explicit
        # times still get a date-aware route (avoids seasonal-road
        # closures like Yellowstone's US-191).
        dep: datetime | None = from_node.departure_time or from_node.arrival_time
        if dep is None:
            all_nodes = await self._node_repo.list_by_plan(trip_id, plan_id)
            dep_map = _build_departure_map(all_nodes, existing_edges)
            dep = dep_map.get(from_node_id)

        # Auto-fetch or estimate route data when not provided
        estimated_speed = _ESTIMATION_SPEEDS_KMH.get(travel_mode)
        if (
            not route_polyline
            and not travel_time_hours
            and estimated_speed
            and from_latlng
            and to_latlng
        ):
            dist = _haversine_km(
                from_latlng["lat"], from_latlng["lng"],
                to_latlng["lat"], to_latlng["lng"],
            )
            distance_km = round(dist, 1)
            travel_time_hours = round(dist / estimated_speed, 2)
        elif (
            not route_polyline
            and not travel_time_hours
            and self._route_service is not None
        ):
            route_data = await self._route_service.get_route_data(
                from_latlng, to_latlng, travel_mode,
                dep,
                from_name=from_node.name,
                to_name=to_node.name,
                from_place_id=from_node.place_id,
                to_place_id=to_node.place_id,
            )
            if route_data:
                route_polyline = route_data.polyline
                travel_time_hours = route_data.travel_time_hours or 0
                distance_km = route_data.distance_km
                if not notes and route_data.notes:
                    notes = route_data.notes

        edge = Edge(
            id=edge_id(),
            from_node_id=from_node_id,
            to_node_id=to_node_id,
            travel_mode=TravelMode(travel_mode),
            travel_time_hours=travel_time_hours,
            distance_km=distance_km,
            route_polyline=route_polyline,
            notes=notes,
        )
        return await self._create_edge_if_new(
            trip_id, plan_id, edge,
            from_latlng=from_latlng,
            to_latlng=to_latlng,
            existing_edges=existing_edges,
            departure_time=dep,
            from_name=from_node.name,
            to_name=to_node.name,
            from_place_id=from_node.place_id,
            to_place_id=to_node.place_id,
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
        duration_minutes: int | None = None,
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
        if leg_a_travel_time_hours is None and leg_b_travel_time_hours is None:
            if leg_a_distance_km and leg_b_distance_km and (leg_a_distance_km + leg_b_distance_km) > 0:
                ratio = leg_a_distance_km / (leg_a_distance_km + leg_b_distance_km)
                leg_a_travel_time_hours = orig_time * ratio
                leg_b_travel_time_hours = orig_time * (1 - ratio)
            else:
                leg_a_travel_time_hours = orig_time / 2
                leg_b_travel_time_hours = orig_time / 2

        resolved_arrival = parse_dt(arrival_time) if arrival_time else None
        resolved_departure = parse_dt(departure_time) if departure_time else None

        new_node = Node(
            id=node_id(),
            name=name,
            type=NodeType(node_type),
            lat_lng=LatLng(lat=lat, lng=lng),
            arrival_time=resolved_arrival,
            departure_time=resolved_departure,
            duration_minutes=duration_minutes,
            timezone=resolve_timezone(lat, lng),
            place_id=place_id,
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
            dep_a: datetime | None = from_node.departure_time or from_node.arrival_time
            if dep_a is None:
                all_nodes = await self._node_repo.list_by_plan(trip_id, plan_id)
                all_edges = await self._edge_repo.list_by_plan(trip_id, plan_id)
                dep_a = _build_departure_map(all_nodes, all_edges).get(
                    original.from_node_id
                )
            dep_b = resolved_departure or resolved_arrival or dep_a
            if edge_a.route_polyline is None and mode_a not in (TravelMode.FLIGHT, TravelMode.FERRY):
                self._spawn_background(
                    self._route_service.fetch_and_patch_polyline(
                        trip_id, plan_id, edge_a.id,
                        from_latlng, new_latlng, str(mode_a), self._edge_repo,
                        departure_time=dep_a,
                        from_name=from_node.name,
                        to_name=name,
                        from_place_id=from_node.place_id,
                        to_place_id=place_id,
                    )
                )
            if edge_b.route_polyline is None and mode_b not in (TravelMode.FLIGHT, TravelMode.FERRY):
                self._spawn_background(
                    self._route_service.fetch_and_patch_polyline(
                        trip_id, plan_id, edge_b.id,
                        new_latlng, to_latlng, str(mode_b), self._edge_repo,
                        departure_time=dep_b,
                        from_name=name,
                        to_name=to_node.name,
                        from_place_id=place_id,
                        to_place_id=to_node.place_id,
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
        duration_minutes: int | None = None,
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

        resolved_arrival = parse_dt(arrival_time) if arrival_time else None
        resolved_departure = parse_dt(departure_time) if departure_time else None

        new_node = Node(
            id=new_id,
            name=name,
            type=NodeType(node_type),
            lat_lng=LatLng(lat=lat, lng=lng),
            arrival_time=resolved_arrival,
            departure_time=resolved_departure,
            duration_minutes=duration_minutes,
            timezone=resolve_timezone(lat, lng),
            place_id=place_id,
            created_by=created_by,
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )

        new_latlng = {"lat": lat, "lng": lng}

        # Build all edges
        edges_to_create: list[Edge] = []
        edge_latlng_pairs: list[tuple[dict | None, dict | None]] = []
        edge_name_pairs: list[tuple[str | None, str | None]] = []
        edge_place_id_pairs: list[tuple[str | None, str | None]] = []

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
            edge_name_pairs.append((from_node.get("name") if from_node else None, name))
            edge_place_id_pairs.append((from_node.get("place_id") if from_node else None, place_id))

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
            edge_name_pairs.append((name, to_node.get("name") if to_node else None))
            edge_place_id_pairs.append((place_id, to_node.get("place_id") if to_node else None))

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
            departure_map = _build_departure_map(all_nodes_raw, all_edges_raw)
            for e, (from_ll, to_ll), (fn, tn), (fp, tp) in zip(
                edges_to_create, edge_latlng_pairs, edge_name_pairs,
                edge_place_id_pairs, strict=True,
            ):
                if e.route_polyline is None and e.travel_mode != TravelMode.FERRY:
                    dep = departure_map.get(e.from_node_id) or resolved_departure or resolved_arrival
                    self._spawn_background(
                        self._route_service.fetch_and_patch_polyline(
                            trip_id, plan_id, e.id,
                            from_ll, to_ll, str(e.travel_mode), self._edge_repo,
                            departure_time=dep,
                            from_name=fn,
                            to_name=tn,
                            from_place_id=fp,
                            to_place_id=tp,
                        )
                    )

        return {
            "node": new_node.model_dump(mode="json"),
            "edges": [e.model_dump(mode="json") for e in edges_to_create],
        }
