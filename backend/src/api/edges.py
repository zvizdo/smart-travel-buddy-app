"""Edge endpoints: list, update."""

from backend.src.auth.firebase_auth import get_current_user
from backend.src.auth.permissions import require_role
from backend.src.deps import get_edge_repo, get_trip_service
from backend.src.repositories.edge_repository import EdgeRepository
from backend.src.services.trip_service import TripService
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from shared.models import TripRole

router = APIRouter(tags=["edges"])


class EdgeUpdateRequest(BaseModel):
    travel_mode: str | None = None
    travel_time_hours: float | None = None
    distance_km: float | None = None
    route_polyline: str | None = None


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
):
    """Update an edge's travel data or route polyline."""
    trip = await trip_service.get_trip(trip_id, user["uid"])
    require_role(trip, user["uid"], TripRole.ADMIN, TripRole.PLANNER)

    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if not updates:
        raise ValueError("No fields to update")

    await edge_repo.update_edge(trip_id, plan_id, edge_id, updates)
    return {"edge_id": edge_id, **updates}
