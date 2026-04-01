"""User-specific context for the Gemini agent."""

from dataclasses import dataclass

from shared.dag.paths import compute_participant_paths, detect_divergence_points
from shared.models.trip import Trip, TripRole


@dataclass(frozen=True)
class UserContext:
    """Computed context about the user chatting with the agent."""

    user_id: str
    display_name: str
    role: TripRole
    can_mutate: bool
    resolved_path: list[str] | None


def build_user_context(
    trip: Trip,
    user_id: str,
    display_name: str,
    nodes: list[dict],
    edges: list[dict],
    plan_id: str,
    active_plan_id: str | None,
) -> UserContext:
    """Build user context from trip data and DAG topology.

    Args:
        trip: The trip object with participants.
        user_id: The current user's ID.
        display_name: The user's display name, resolved from the users collection.
        nodes: All nodes in the current plan.
        edges: All edges in the current plan.
        plan_id: The plan the user is currently viewing/chatting about.
        active_plan_id: The trip's active plan ID (may be None).
    """
    participant = trip.participants[user_id]

    if participant.role == TripRole.ADMIN:
        can_mutate = True
    elif participant.role == TripRole.PLANNER:
        can_mutate = plan_id != active_plan_id
    else:
        can_mutate = False

    resolved_path = _compute_user_path(user_id, nodes, edges)

    return UserContext(
        user_id=user_id,
        display_name=display_name,
        role=participant.role,
        can_mutate=can_mutate,
        resolved_path=resolved_path,
    )


def _compute_user_path(
    user_id: str,
    nodes: list[dict],
    edges: list[dict],
) -> list[str] | None:
    """Return ordered node names for user's path, or None if not applicable."""
    divergences = detect_divergence_points(nodes, edges)
    if not divergences:
        return None

    path_result = compute_participant_paths(nodes, edges, [user_id])

    user_unresolved = [u for u in path_result.unresolved if u["user_id"] == user_id]
    if user_unresolved:
        return None

    node_ids = path_result.paths.get(user_id, [])
    if not node_ids:
        return None

    node_map = {n["id"]: n for n in nodes}
    return [node_map[nid]["name"] for nid in node_ids if nid in node_map]


def build_user_context_text(ctx: UserContext) -> str:
    """Render user context as text for inclusion in the agent system prompt."""
    lines = [
        f"You are chatting with {ctx.display_name} (role: {ctx.role.value}).",
        "",
        "Trip roles:",
        "  - admin: Full control. Can modify the trip, manage participants, and change settings.",
        "  - planner: Can modify the itinerary (add/remove/update stops and connections).",
        "  - viewer: Can view and discuss the trip but CANNOT modify it.",
    ]

    if not ctx.can_mutate and ctx.role == TripRole.PLANNER:
        lines.append("")
        lines.append(
            "This user is a PLANNER viewing the ACTIVE plan. You must NOT call add_node, "
            "update_node, delete_node, add_edge, or delete_edge on this plan. If they ask "
            "for changes, explain that planners can only modify draft/alternative plans, "
            "not the active plan. Suggest they create or switch to a draft plan to make changes."
        )
    elif not ctx.can_mutate:
        lines.append("")
        lines.append(
            "This user is a VIEWER. You must NOT call add_node, update_node, "
            "delete_node, add_edge, or delete_edge. If they ask for changes, "
            "politely explain they need a planner or admin to make modifications."
        )

    if ctx.resolved_path is not None:
        lines.append("")
        lines.append(f"{ctx.display_name}'s path through the trip:")
        lines.append("  " + " -> ".join(ctx.resolved_path))

    return "\n".join(lines)
