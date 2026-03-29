"""Node endpoints: list, create, branch, update, delete, cascade, participant assignment, actions."""

import uuid
from datetime import UTC, datetime

from backend.src.auth.firebase_auth import get_current_user
from backend.src.auth.permissions import require_role
from backend.src.deps import (
    get_action_repo,
    get_dag_service,
    get_node_repo,
    get_notification_service,
    get_trip_service,
)
from backend.src.services.dag_service import DAGService
from backend.src.services.notification_service import NotificationService
from backend.src.services.trip_service import TripService
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from shared.models import Action, ActionType, PlaceData, TripRole
from shared.repositories.action_repository import ActionRepository
from shared.repositories.node_repository import NodeRepository

router = APIRouter(tags=["nodes"])


class NodeUpdateRequest(BaseModel):
    name: str | None = None
    type: str | None = None
    arrival_time: str | None = None
    departure_time: str | None = None
    lat: float | None = None
    lng: float | None = None
    client_updated_at: str | None = None


class CreateNodeRequest(BaseModel):
    name: str
    type: str = "place"
    lat: float
    lng: float
    place_id: str | None = None
    arrival_time: str | None = None
    departure_time: str | None = None
    connect_after_node_id: str | None = None
    connect_before_node_id: str | None = None
    travel_mode: str = "drive"
    travel_time_hours: float = 1.0
    distance_km: float | None = None
    route_polyline: str | None = None


class ParticipantAssignmentRequest(BaseModel):
    participant_ids: list[str]


class BranchFromNodeRequest(BaseModel):
    name: str
    type: str = "place"
    lat: float
    lng: float
    place_id: str | None = None
    arrival_time: str | None = None
    departure_time: str | None = None
    travel_mode: str = "drive"
    travel_time_hours: float = 1.0
    distance_km: float | None = None
    route_polyline: str | None = None
    connect_to_node_id: str | None = None


class CreateActionRequest(BaseModel):
    type: str
    content: str = Field(min_length=1, max_length=2000)
    place_data: dict | None = None


@router.get("/trips/{trip_id}/plans/{plan_id}/nodes")
async def list_nodes(
    trip_id: str,
    plan_id: str,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    node_repo: NodeRepository = Depends(get_node_repo),
):
    """List all nodes in a plan."""
    await trip_service.get_trip(trip_id, user["uid"])
    nodes = await node_repo.list_by_plan(trip_id, plan_id)
    return {"nodes": nodes}


@router.post("/trips/{trip_id}/plans/{plan_id}/nodes", status_code=201)
async def create_node(
    trip_id: str,
    plan_id: str,
    body: CreateNodeRequest,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    dag_service: DAGService = Depends(get_dag_service),
):
    """Create a new node. Optionally connect it after an existing node."""
    trip = await trip_service.get_trip(trip_id, user["uid"])
    require_role(trip, user["uid"], TripRole.ADMIN, TripRole.PLANNER)

    if body.connect_after_node_id and body.connect_before_node_id:
        raise ValueError("Cannot specify both connect_after_node_id and connect_before_node_id")

    result = await dag_service.create_node(
        trip_id=trip_id,
        plan_id=plan_id,
        name=body.name,
        node_type=body.type,
        lat=body.lat,
        lng=body.lng,
        place_id=body.place_id,
        arrival_time=body.arrival_time,
        departure_time=body.departure_time,
        connect_after_node_id=body.connect_after_node_id,
        connect_before_node_id=body.connect_before_node_id,
        travel_mode=body.travel_mode,
        travel_time_hours=body.travel_time_hours,
        distance_km=body.distance_km,
        route_polyline=body.route_polyline,
        created_by=user["uid"],
    )
    return result


@router.post("/trips/{trip_id}/plans/{plan_id}/nodes/{node_id}/branch", status_code=201)
async def branch_from_node(
    trip_id: str,
    plan_id: str,
    node_id: str,
    body: BranchFromNodeRequest,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    dag_service: DAGService = Depends(get_dag_service),
):
    """Create a new node branching off from an existing node."""
    trip = await trip_service.get_trip(trip_id, user["uid"])
    require_role(trip, user["uid"], TripRole.ADMIN, TripRole.PLANNER)

    result = await dag_service.create_branch(
        trip_id=trip_id,
        plan_id=plan_id,
        from_node_id=node_id,
        name=body.name,
        node_type=body.type,
        lat=body.lat,
        lng=body.lng,
        place_id=body.place_id,
        arrival_time=body.arrival_time,
        departure_time=body.departure_time,
        travel_mode=body.travel_mode,
        travel_time_hours=body.travel_time_hours,
        distance_km=body.distance_km,
        route_polyline=body.route_polyline,
        connect_to_node_id=body.connect_to_node_id,
        created_by=user["uid"],
    )
    return result


@router.patch("/trips/{trip_id}/plans/{plan_id}/nodes/{node_id}")
async def update_node(
    trip_id: str,
    plan_id: str,
    node_id: str,
    body: NodeUpdateRequest,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    dag_service: DAGService = Depends(get_dag_service),
    notification_service: NotificationService = Depends(get_notification_service),
):
    """Update a node. Returns cascade preview if dates changed."""
    trip = await trip_service.get_trip(trip_id, user["uid"])
    require_role(trip, user["uid"], TripRole.ADMIN, TripRole.PLANNER)

    client_updated_at = body.client_updated_at
    raw = body.model_dump()
    updates: dict = {}
    for k, v in raw.items():
        if v is not None and k != "client_updated_at":
            updates[k] = v

    # Convert lat/lng into lat_lng sub-object
    if "lat" in updates or "lng" in updates:
        updates["lat_lng"] = {
            "lat": updates.pop("lat", None),
            "lng": updates.pop("lng", None),
        }

    if not updates:
        raise ValueError("No fields to update")

    result = await dag_service.update_node_with_cascade_preview(
        trip_id, plan_id, node_id, updates,
        client_updated_at=client_updated_at,
        edited_by=user["uid"],
        notification_service=notification_service,
    )
    return result


@router.delete("/trips/{trip_id}/plans/{plan_id}/nodes/{node_id}")
async def delete_node(
    trip_id: str,
    plan_id: str,
    node_id: str,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    dag_service: DAGService = Depends(get_dag_service),
):
    """Delete a node and reconnect edges around it."""
    trip = await trip_service.get_trip(trip_id, user["uid"])
    require_role(trip, user["uid"], TripRole.ADMIN, TripRole.PLANNER)

    result = await dag_service.delete_node(trip_id, plan_id, node_id)
    return result


@router.post("/trips/{trip_id}/plans/{plan_id}/nodes/{node_id}/cascade/confirm")
async def confirm_cascade(
    trip_id: str,
    plan_id: str,
    node_id: str,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    dag_service: DAGService = Depends(get_dag_service),
):
    """Confirm cascading update after preview."""
    trip = await trip_service.get_trip(trip_id, user["uid"])
    require_role(trip, user["uid"], TripRole.ADMIN, TripRole.PLANNER)

    result = await dag_service.confirm_cascade(trip_id, plan_id, node_id)
    return result


@router.patch("/trips/{trip_id}/plans/{plan_id}/nodes/{node_id}/participants")
async def assign_participants(
    trip_id: str,
    plan_id: str,
    node_id: str,
    body: ParticipantAssignmentRequest,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    dag_service: DAGService = Depends(get_dag_service),
    node_repo: NodeRepository = Depends(get_node_repo),
):
    """Assign participants to a node at a divergence point (admin only).

    Validates that the node is reachable — it must be downstream of
    a divergence point (a node with out-degree > 1).
    """
    trip = await trip_service.get_trip(trip_id, user["uid"])
    require_role(trip, user["uid"], TripRole.ADMIN)

    # Validate participants are trip members
    for pid in body.participant_ids:
        if pid not in trip.participants:
            raise ValueError(f"User {pid} is not a trip participant")

    # Validate node is downstream of a divergence point
    all_edges_raw = await dag_service._edge_repo.list_by_plan(trip_id, plan_id)
    in_edges = [e for e in all_edges_raw if e["to_node_id"] == node_id]
    has_divergent_parent = False
    for edge in in_edges:
        parent_id = edge["from_node_id"]
        parent_out = sum(1 for e in all_edges_raw if e["from_node_id"] == parent_id)
        if parent_out > 1:
            has_divergent_parent = True
            break

    # Also allow assignment on nodes that are themselves divergence points or have no edges
    out_degree = sum(1 for e in all_edges_raw if e["from_node_id"] == node_id)
    if not has_divergent_parent and out_degree <= 1 and in_edges:
        raise ValueError(
            "Cannot assign participants to this node — it is not on a divergent path"
        )

    await node_repo.update_node(
        trip_id, plan_id, node_id, {"participant_ids": body.participant_ids}
    )
    return {"node_id": node_id, "participant_ids": body.participant_ids}


@router.post("/trips/{trip_id}/plans/{plan_id}/nodes/{node_id}/choose")
async def choose_path(
    trip_id: str,
    plan_id: str,
    node_id: str,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    node_repo: NodeRepository = Depends(get_node_repo),
):
    """Self-assign: add current user to a node's participant_ids. Any role."""
    trip = await trip_service.get_trip(trip_id, user["uid"])
    require_role(trip, user["uid"], TripRole.ADMIN, TripRole.PLANNER, TripRole.VIEWER)

    node = await node_repo.get_node_or_raise(trip_id, plan_id, node_id)
    current_pids = list(node.participant_ids or [])
    uid = user["uid"]
    if uid not in current_pids:
        current_pids.append(uid)
        await node_repo.update_node(
            trip_id, plan_id, node_id, {"participant_ids": current_pids}
        )
    return {"node_id": node_id, "participant_ids": current_pids}


@router.delete("/trips/{trip_id}/plans/{plan_id}/nodes/{node_id}/choose")
async def unchoose_path(
    trip_id: str,
    plan_id: str,
    node_id: str,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    node_repo: NodeRepository = Depends(get_node_repo),
):
    """Self-unassign: remove current user from a node's participant_ids. Any role."""
    trip = await trip_service.get_trip(trip_id, user["uid"])
    require_role(trip, user["uid"], TripRole.ADMIN, TripRole.PLANNER, TripRole.VIEWER)

    node = await node_repo.get_node_or_raise(trip_id, plan_id, node_id)
    current_pids = list(node.participant_ids or [])
    uid = user["uid"]
    if uid in current_pids:
        current_pids.remove(uid)
        await node_repo.update_node(
            trip_id, plan_id, node_id, {
                "participant_ids": current_pids if current_pids else None,
            }
        )
    return {"node_id": node_id, "participant_ids": current_pids or None}


@router.post(
    "/trips/{trip_id}/plans/{plan_id}/nodes/{node_id}/actions", status_code=201
)
async def create_action(
    trip_id: str,
    plan_id: str,
    node_id: str,
    body: CreateActionRequest,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    action_repo: ActionRepository = Depends(get_action_repo),
):
    """Add a note, todo, or place to a node. All roles including Viewer."""
    trip = await trip_service.get_trip(trip_id, user["uid"])
    require_role(trip, user["uid"], TripRole.ADMIN, TripRole.PLANNER, TripRole.VIEWER)

    place_data = PlaceData(**body.place_data) if body.place_data else None
    action = Action(
        id=str(uuid.uuid4()),
        type=ActionType(body.type),
        content=body.content,
        place_data=place_data,
        created_by=user["uid"],
        created_at=datetime.now(UTC),
    )
    result = await action_repo.create_action(trip_id, plan_id, node_id, action)
    return result


@router.get("/trips/{trip_id}/plans/{plan_id}/nodes/{node_id}/actions")
async def list_actions(
    trip_id: str,
    plan_id: str,
    node_id: str,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    action_repo: ActionRepository = Depends(get_action_repo),
):
    """List all actions on a node."""
    await trip_service.get_trip(trip_id, user["uid"])
    actions = await action_repo.list_by_node(trip_id, plan_id, node_id)
    return {"actions": actions}


class ToggleActionRequest(BaseModel):
    is_completed: bool


@router.patch(
    "/trips/{trip_id}/plans/{plan_id}/nodes/{node_id}/actions/{action_id}"
)
async def update_action(
    trip_id: str,
    plan_id: str,
    node_id: str,
    action_id: str,
    body: ToggleActionRequest,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    action_repo: ActionRepository = Depends(get_action_repo),
):
    """Toggle an action's completion status (for todos)."""
    await trip_service.get_trip(trip_id, user["uid"])
    await action_repo.update_action(
        trip_id, plan_id, node_id, action_id,
        {"is_completed": body.is_completed},
    )
    return {"action_id": action_id, "is_completed": body.is_completed}


@router.delete(
    "/trips/{trip_id}/plans/{plan_id}/nodes/{node_id}/actions/{action_id}"
)
async def delete_action(
    trip_id: str,
    plan_id: str,
    node_id: str,
    action_id: str,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    action_repo: ActionRepository = Depends(get_action_repo),
):
    """Delete an action from a node."""
    await trip_service.get_trip(trip_id, user["uid"])
    await action_repo.delete_action(trip_id, plan_id, node_id, action_id)
    return {"deleted": action_id}
