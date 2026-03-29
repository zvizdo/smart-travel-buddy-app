"""Path computation and warnings endpoints."""

from backend.src.auth.firebase_auth import get_current_user
from backend.src.deps import get_edge_repo, get_node_repo, get_trip_service
from backend.src.repositories.edge_repository import EdgeRepository
from backend.src.repositories.node_repository import NodeRepository
from backend.src.services.trip_service import TripService
from fastapi import APIRouter, Depends

from shared.dag.paths import compute_participant_paths, detect_unresolved_flows

router = APIRouter(tags=["paths"])

PATH_COLORS = [
    "#FF5733", "#3498DB", "#2ECC71", "#9B59B6", "#F39C12",
    "#1ABC9C", "#E74C3C", "#3498DB", "#E67E22", "#1F77B4",
]


@router.get("/trips/{trip_id}/plans/{plan_id}/paths")
async def get_paths(
    trip_id: str,
    plan_id: str,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    node_repo: NodeRepository = Depends(get_node_repo),
    edge_repo: EdgeRepository = Depends(get_edge_repo),
):
    """Compute participant paths for the current plan."""
    trip = await trip_service.get_trip(trip_id, user["uid"])
    participant_ids = list(trip.participants.keys())

    nodes = await node_repo.list_by_plan(trip_id, plan_id)
    edges = await edge_repo.list_by_plan(trip_id, plan_id)

    result = compute_participant_paths(nodes, edges, participant_ids)

    paths_with_colors = {}
    for i, (uid, node_ids) in enumerate(result.paths.items()):
        paths_with_colors[uid] = {
            "node_ids": node_ids,
            "color": PATH_COLORS[i % len(PATH_COLORS)],
        }

    return {
        "paths": paths_with_colors,
        "unresolved": result.unresolved,
    }


@router.get("/trips/{trip_id}/plans/{plan_id}/warnings")
async def get_warnings(
    trip_id: str,
    plan_id: str,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    node_repo: NodeRepository = Depends(get_node_repo),
    edge_repo: EdgeRepository = Depends(get_edge_repo),
):
    """Check for unresolved participant flows at divergence points."""
    trip = await trip_service.get_trip(trip_id, user["uid"])
    participant_ids = list(trip.participants.keys())

    nodes = await node_repo.list_by_plan(trip_id, plan_id)
    edges = await edge_repo.list_by_plan(trip_id, plan_id)

    warnings = detect_unresolved_flows(nodes, edges, participant_ids)

    for w in warnings:
        w["user_name"] = ""
        node = next((n for n in nodes if n["id"] == w["divergence_node_id"]), None)
        w["divergence_node_name"] = node["name"] if node else ""

    return {"warnings": warnings}
