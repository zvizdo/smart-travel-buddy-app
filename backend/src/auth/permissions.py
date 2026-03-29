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
