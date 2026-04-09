"""Import chat, build, and ongoing agent endpoints."""

import logging
from datetime import UTC, datetime

from backend.src.auth.firebase_auth import get_current_user
from backend.src.auth.permissions import require_role
from backend.src.deps import (
    get_agent_service,
    get_chat_history_repo,
    get_dag_service,
    get_edge_repo,
    get_flight_service,
    get_node_repo,
    get_plan_repo,
    get_preference_repo,
    get_trip_service,
    get_user_service,
)
from backend.src.repositories.chat_history_repository import ChatHistoryRepository
from backend.src.repositories.preference_repository import PreferenceRepository
from backend.src.services.agent_service import AgentService
from shared.services.dag_service import DAGService
from backend.src.services.trip_service import TripService
from backend.src.services.user_service import UserService
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from shared.models import Plan, PlanStatus, TripRole
from shared.services.flight_service import FlightService
from shared.repositories.edge_repository import EdgeRepository
from shared.repositories.node_repository import NodeRepository
from shared.repositories.plan_repository import PlanRepository
from shared.tools.id_gen import generate_id

logger = logging.getLogger(__name__)

router = APIRouter(tags=["agent"])


class ChatMessage(BaseModel):
    role: str
    content: str


class ImportChatRequest(BaseModel):
    messages: list[ChatMessage]


class ImportBuildRequest(BaseModel):
    messages: list[ChatMessage]


class OngoingChatRequest(BaseModel):
    message: str
    plan_id: str | None = None


@router.post("/trips/{trip_id}/import/chat")
async def import_chat(
    trip_id: str,
    body: ImportChatRequest,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    agent_service: AgentService = Depends(get_agent_service),
):
    """Send messages in the import conversation. Returns agent reply + notes."""
    trip = await trip_service.get_trip(trip_id, user["uid"])
    require_role(trip, user["uid"], TripRole.ADMIN, TripRole.PLANNER)

    messages = [m.model_dump() for m in body.messages]
    result = await agent_service.import_chat(messages)

    return {
        "reply": {"role": "assistant", "content": result.reply},
        "notes": [n.model_dump() for n in result.notes],
        "ready_to_build": result.ready_to_build,
    }


@router.post("/trips/{trip_id}/import/build", status_code=201)
async def import_build(
    trip_id: str,
    body: ImportBuildRequest,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    agent_service: AgentService = Depends(get_agent_service),
    dag_service: DAGService = Depends(get_dag_service),
    plan_repo: PlanRepository = Depends(get_plan_repo),
):
    """Build the DAG from the finalized import conversation using agent tools.

    Creates an empty plan first, then the agent uses add_node/add_edge tools
    to construct the DAG step-by-step. Nodes and edges are written to Firestore
    as they are created, so the frontend can watch via onSnapshot.
    """
    trip = await trip_service.get_trip(trip_id, user["uid"])
    require_role(trip, user["uid"], TripRole.ADMIN, TripRole.PLANNER)

    # Create an empty plan for the agent to populate
    plan = Plan(
        id=generate_id("p"),
        name="Main Route",
        status=PlanStatus.ACTIVE,
        created_by=user["uid"],
        created_at=datetime.now(UTC),
    )
    await plan_repo.create_plan(trip_id, plan)

    # Set as active plan
    await dag_service._trip_repo.update_trip(trip_id, {
        "active_plan_id": plan.id,
        "updated_at": datetime.now(UTC).isoformat(),
    })

    # Run the build agent — nodes/edges are written to Firestore as they're created
    messages = [m.model_dump() for m in body.messages]
    result = await agent_service.build_dag(
        messages=messages,
        dag_service=dag_service,
        trip_id=trip_id,
        plan_id=plan.id,
        user_id=user["uid"],
    )

    return {
        "plan_id": plan.id,
        "summary": result.summary,
        "nodes_created": result.node_count,
        "edges_created": result.edge_count,
        "actions_taken": [a.model_dump() for a in result.actions_taken],
    }


@router.get("/trips/{trip_id}/agent/history")
async def get_agent_history(
    trip_id: str,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    chat_history_repo: ChatHistoryRepository = Depends(get_chat_history_repo),
):
    """Load the agent conversation history from GCS."""
    await trip_service.get_trip(trip_id, user["uid"])
    messages, is_new_session = chat_history_repo.load(user["uid"], trip_id)
    return {
        "messages": messages,
        "is_new_session": is_new_session,
    }


@router.delete("/trips/{trip_id}/agent/history", status_code=204)
async def delete_agent_history(
    trip_id: str,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    chat_history_repo: ChatHistoryRepository = Depends(get_chat_history_repo),
):
    """Delete the agent conversation history, starting a fresh session."""
    await trip_service.get_trip(trip_id, user["uid"])
    chat_history_repo.delete(user["uid"], trip_id)


@router.post("/trips/{trip_id}/agent/chat")
async def ongoing_chat(
    trip_id: str,
    body: OngoingChatRequest,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    agent_service: AgentService = Depends(get_agent_service),
    dag_service: DAGService = Depends(get_dag_service),
    chat_history_repo: ChatHistoryRepository = Depends(get_chat_history_repo),
    node_repo: NodeRepository = Depends(get_node_repo),
    edge_repo: EdgeRepository = Depends(get_edge_repo),
    preference_repo: PreferenceRepository = Depends(get_preference_repo),
    user_service: UserService = Depends(get_user_service),
    flight_service: FlightService = Depends(get_flight_service),
):
    """Send a message to the ongoing trip management agent.

    Loads conversation history from GCS (12h TTL), injects trip context,
    and returns the agent's reply with actions taken and preferences extracted.
    """
    trip = await trip_service.get_trip(trip_id, user["uid"])
    plan_id = body.plan_id or trip.active_plan_id
    if not plan_id:
        raise ValueError("Trip has no active plan. Import an itinerary first.")

    # Resolve user's display name from the users collection
    user_profile = await user_service.get_user(user["uid"])
    display_name = user_profile.display_name if user_profile else user["uid"]

    # Load conversation history from GCS
    history, is_new_session = chat_history_repo.load(user["uid"], trip_id)

    # Load current trip context for the selected plan
    nodes = await node_repo.list_by_plan(trip_id, plan_id)
    edges = await edge_repo.list_by_plan(trip_id, plan_id)
    preferences = await preference_repo.list_by_trip(trip_id)

    # Call the ongoing agent with DAG tools
    result = await agent_service.ongoing_chat(
        message=body.message,
        history=history,
        nodes=nodes,
        edges=edges,
        preferences=preferences,
        dag_service=dag_service,
        trip_id=trip_id,
        plan_id=plan_id,
        user_id=user["uid"],
        trip=trip,
        display_name=display_name,
        flight_service=flight_service,
    )

    # Save preferences if any were extracted
    extracted_prefs = agent_service.extract_preferences(result, user["uid"])
    for pref in extracted_prefs:
        await preference_repo.create_preference(trip_id, pref)

    # Update conversation history in GCS
    history.append({"role": "user", "content": body.message})
    history.append({"role": "assistant", "content": result.reply})
    chat_history_repo.save(user["uid"], trip_id, history)

    return {
        "reply": result.reply,
        "is_new_session": is_new_session,
        "actions_taken": [a.model_dump() for a in result.actions_taken],
        "preferences_extracted": [p.model_dump() for p in result.preferences_extracted],
    }
