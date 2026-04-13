import asyncio
from typing import TYPE_CHECKING

from shared.models.plan import Plan, PlanStatus
from shared.models.trip import Trip, TripRole

if TYPE_CHECKING:
    from backend.src.services.trip_service import TripService
    from shared.repositories.plan_repository import PlanRepository


def require_role(trip: Trip, user_id: str, *allowed_roles: TripRole) -> TripRole:
    """Check that user has one of the allowed roles in the trip.

    Returns the user's role if authorized, raises PermissionError otherwise.
    """
    participant = trip.participants.get(user_id)
    if participant is None:
        raise PermissionError("You are not a participant of this trip")
    if participant.role not in allowed_roles:
        role_names = ", ".join(r.value for r in allowed_roles)
        raise PermissionError(
            f"This action requires one of the following roles: {role_names}"
        )
    return participant.role


def require_plan_editable(trip: Trip, plan: Plan, user_id: str) -> TripRole:
    """Enforce that structural edits are allowed for this user on this plan.

    Admins can edit any plan. Planners can only edit draft plans.
    """
    role = require_role(trip, user_id, TripRole.ADMIN, TripRole.PLANNER)
    if role == TripRole.PLANNER and plan.status != PlanStatus.DRAFT:
        raise PermissionError(
            "Planners can only edit draft plans. "
            "Clone the active plan to create a draft version."
        )
    return role


async def resolve_editable_plan(
    trip_service: "TripService",
    plan_repo: "PlanRepository",
    trip_id: str,
    plan_id: str,
    user_id: str,
) -> tuple[Trip, Plan]:
    """Fetch trip + plan in parallel and enforce editable-plan permissions.

    Replaces the sequential `get_trip` + `plan_repo.get_or_raise` preamble
    used by every node/edge mutation endpoint. Halves permission-check
    latency on the interactive map hot path.
    """
    trip, plan_data = await asyncio.gather(
        trip_service.get_trip(trip_id, user_id),
        plan_repo.get_or_raise(plan_id, trip_id=trip_id),
    )
    plan = Plan(**plan_data)
    require_plan_editable(trip, plan, user_id)
    return trip, plan
