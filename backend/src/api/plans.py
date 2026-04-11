"""Plan versioning endpoints: clone and promote plans."""

from backend.src.auth.firebase_auth import get_current_user
from backend.src.auth.permissions import require_role
from backend.src.deps import get_plan_service, get_trip_service
from backend.src.services.trip_service import TripService
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from shared.models import TripRole
from shared.services.plan_service import PlanService

router = APIRouter(tags=["plans"])


class ClonePlanRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    source_plan_id: str
    include_actions: bool = False


@router.post("/trips/{trip_id}/plans", status_code=201)
async def clone_plan(
    trip_id: str,
    body: ClonePlanRequest,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    plan_service: PlanService = Depends(get_plan_service),
):
    """Create an alternative plan by deep-cloning an existing plan. Requires Planner or Admin."""
    trip = await trip_service.get_trip(trip_id, user["uid"])
    require_role(trip, user["uid"], TripRole.ADMIN, TripRole.PLANNER)

    result = await plan_service.clone_plan(
        trip_id=trip_id,
        source_plan_id=body.source_plan_id,
        name=body.name,
        created_by=user["uid"],
        include_actions=body.include_actions,
    )
    return result


@router.get("/trips/{trip_id}/plans")
async def list_plans(
    trip_id: str,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    plan_service: PlanService = Depends(get_plan_service),
):
    """List all plans for a trip."""
    await trip_service.get_trip(trip_id, user["uid"])
    plans = await plan_service.list_plans(trip_id)
    return {"plans": plans}


@router.delete("/trips/{trip_id}/plans/{plan_id}", status_code=204)
async def delete_plan(
    trip_id: str,
    plan_id: str,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    plan_service: PlanService = Depends(get_plan_service),
):
    """Delete a non-active plan. Requires Admin or Planner."""
    trip = await trip_service.get_trip(trip_id, user["uid"])
    require_role(trip, user["uid"], TripRole.ADMIN, TripRole.PLANNER)
    await plan_service.delete_plan(trip_id=trip_id, plan_id=plan_id)


@router.post("/trips/{trip_id}/plans/{plan_id}/promote")
async def promote_plan(
    trip_id: str,
    plan_id: str,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    plan_service: PlanService = Depends(get_plan_service),
):
    """Promote a plan to active. Admin only."""
    trip = await trip_service.get_trip(trip_id, user["uid"])
    require_role(trip, user["uid"], TripRole.ADMIN)

    result = await plan_service.promote_plan(
        trip_id=trip_id,
        plan_id=plan_id,
        promoted_by=user["uid"],
    )
    return result
