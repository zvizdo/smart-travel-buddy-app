"""Edge endpoints: list, update, split, refresh."""

from backend.src.auth.firebase_auth import get_current_user
from backend.src.auth.permissions import require_plan_editable, require_role
from backend.src.deps import (
    get_dag_service,
    get_edge_repo,
    get_node_repo,
    get_plan_repo,
    get_route_service,
    get_trip_service,
)
from backend.src.services.trip_service import TripService
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from shared.models.plan import Plan
from shared.models.trip import TripRole
from shared.repositories.edge_repository import EdgeRepository
from shared.repositories.node_repository import NodeRepository
from shared.repositories.plan_repository import PlanRepository
from shared.services.dag_service import DAGService
from shared.services.route_service import RouteService

router = APIRouter(tags=["edges"])


class EdgeUpdateRequest(BaseModel):
    travel_mode: str | None = None
    travel_time_hours: float | None = None
    distance_km: float | None = None
    route_polyline: str | None = None


class LegData(BaseModel):
    travel_mode: str | None = None
    travel_time_hours: float | None = None
    distance_km: float | None = None
    route_polyline: str | None = None


class SplitEdgeRequest(BaseModel):
    name: str
    type: str = "place"
    lat: float
    lng: float
    place_id: str | None = None
    arrival_time: str | None = None
    departure_time: str | None = None
    duration_minutes: int | None = None
    leg_a: LegData | None = None
    leg_b: LegData | None = None


@router.get("/trips/{trip_id}/plans/{plan_id}/edges")
async def list_edges(
    trip_id: str,
    plan_id: str,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    edge_repo: EdgeRepository = Depends(get_edge_repo),
):
    """List all edges in a plan."""
    await trip_service.get_trip(trip_id, user["uid"])
    edges = await edge_repo.list_by_plan(trip_id, plan_id)
    return {"edges": edges}


@router.patch("/trips/{trip_id}/plans/{plan_id}/edges/{edge_id}")
async def update_edge(
    trip_id: str,
    plan_id: str,
    edge_id: str,
    body: EdgeUpdateRequest,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    edge_repo: EdgeRepository = Depends(get_edge_repo),
    plan_repo: PlanRepository = Depends(get_plan_repo),
):
    """Update an edge's travel data or route polyline."""
    trip = await trip_service.get_trip(trip_id, user["uid"])
    plan_data = await plan_repo.get_or_raise(plan_id, trip_id=trip_id)
    require_plan_editable(trip, Plan(**plan_data), user["uid"])

    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if not updates:
        raise ValueError("No fields to update")

    await edge_repo.update_edge(trip_id, plan_id, edge_id, updates)
    return {"edge_id": edge_id, **updates}


@router.post("/trips/{trip_id}/plans/{plan_id}/edges/{edge_id}/split", status_code=201)
async def split_edge(
    trip_id: str,
    plan_id: str,
    edge_id: str,
    body: SplitEdgeRequest,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    dag_service: DAGService = Depends(get_dag_service),
    plan_repo: PlanRepository = Depends(get_plan_repo),
):
    """Insert a new node by splitting an existing edge into two."""
    trip = await trip_service.get_trip(trip_id, user["uid"])
    plan_data = await plan_repo.get_or_raise(plan_id, trip_id=trip_id)
    require_plan_editable(trip, Plan(**plan_data), user["uid"])

    leg_a = body.leg_a or LegData()
    leg_b = body.leg_b or LegData()

    result = await dag_service.split_edge(
        trip_id=trip_id,
        plan_id=plan_id,
        split_edge_id=edge_id,
        name=body.name,
        node_type=body.type,
        lat=body.lat,
        lng=body.lng,
        place_id=body.place_id,
        arrival_time=body.arrival_time,
        departure_time=body.departure_time,
        duration_minutes=body.duration_minutes,
        leg_a_travel_mode=leg_a.travel_mode,
        leg_a_travel_time_hours=leg_a.travel_time_hours,
        leg_a_distance_km=leg_a.distance_km,
        leg_a_route_polyline=leg_a.route_polyline,
        leg_b_travel_mode=leg_b.travel_mode,
        leg_b_travel_time_hours=leg_b.travel_time_hours,
        leg_b_distance_km=leg_b.distance_km,
        leg_b_route_polyline=leg_b.route_polyline,
        created_by=user["uid"],
    )
    return result


@router.post("/trips/{trip_id}/plans/{plan_id}/edges/{edge_id}/refresh")
async def refresh_edge_route(
    trip_id: str,
    plan_id: str,
    edge_id: str,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    edge_repo: EdgeRepository = Depends(get_edge_repo),
    node_repo: NodeRepository = Depends(get_node_repo),
    route_service: RouteService | None = Depends(get_route_service),
):
    """Re-fetch route data (polyline + duration) for an edge. Admin-only dev helper."""
    trip = await trip_service.get_trip(trip_id, user["uid"])
    require_role(trip, user["uid"], TripRole.ADMIN)

    if route_service is None:
        raise ValueError("Route service not available")

    edge = await edge_repo.get_or_raise(edge_id, trip_id=trip_id, plan_id=plan_id)
    from_node = await node_repo.get_or_raise(
        edge["from_node_id"], trip_id=trip_id, plan_id=plan_id,
    )
    to_node = await node_repo.get_or_raise(
        edge["to_node_id"], trip_id=trip_id, plan_id=plan_id,
    )

    from_ll = from_node.get("lat_lng")
    to_ll = to_node.get("lat_lng")
    from_latlng = {"lat": from_ll["lat"], "lng": from_ll["lng"]} if from_ll else None
    to_latlng = {"lat": to_ll["lat"], "lng": to_ll["lng"]} if to_ll else None
    departure_time = from_node.get("departure_time") or from_node.get("arrival_time")

    await route_service.fetch_and_patch_route_data(
        trip_id=trip_id,
        plan_id=plan_id,
        edge_id=edge_id,
        from_latlng=from_latlng,
        to_latlng=to_latlng,
        travel_mode=edge.get("travel_mode", "drive"),
        edge_repo=edge_repo,
        departure_time=departure_time,
        from_name=from_node.get("name"),
        to_name=to_node.get("name"),
        from_place_id=from_node.get("place_id"),
        to_place_id=to_node.get("place_id"),
    )

    return {"status": "refreshed", "edge_id": edge_id}
