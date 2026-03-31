from shared.models.plan import Plan, PlanStatus
from shared.models.trip import Trip, TripRole


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
