from backend.src.repositories.chat_history_repository import ChatHistoryRepository
from backend.src.repositories.invite_link_repository import InviteLinkRepository
from backend.src.repositories.notification_repository import NotificationRepository
from backend.src.repositories.preference_repository import PreferenceRepository
from backend.src.services.agent_service import AgentService
from shared.services.dag_service import DAGService
from backend.src.services.invite_service import InviteService
from backend.src.services.notification_service import NotificationService
from shared.services.plan_service import PlanService
from shared.services.route_service import RouteService
from backend.src.services.trip_service import TripService
from backend.src.services.user_service import UserService
from fastapi import Depends, Request
from google.cloud.firestore import AsyncClient
from google.cloud.storage import Client as GCSClient

from shared.repositories.action_repository import ActionRepository
from shared.repositories.edge_repository import EdgeRepository
from shared.repositories.location_repository import LocationRepository
from shared.repositories.node_repository import NodeRepository
from shared.repositories.plan_repository import PlanRepository
from shared.repositories.trip_repository import TripRepository
from shared.repositories.user_repository import UserRepository


def get_firestore(request: Request) -> AsyncClient:
    """Return the shared Firestore AsyncClient from app state."""
    return request.app.state.firestore


def get_gcs(request: Request) -> GCSClient:
    """Return the shared GCS client from app state."""
    return request.app.state.gcs


def get_trip_repo(db: AsyncClient = Depends(get_firestore)) -> TripRepository:
    return TripRepository(db)


def get_plan_repo(db: AsyncClient = Depends(get_firestore)) -> PlanRepository:
    return PlanRepository(db)


def get_node_repo(db: AsyncClient = Depends(get_firestore)) -> NodeRepository:
    return NodeRepository(db)


def get_edge_repo(db: AsyncClient = Depends(get_firestore)) -> EdgeRepository:
    return EdgeRepository(db)


def get_user_repo(db: AsyncClient = Depends(get_firestore)) -> UserRepository:
    return UserRepository(db)


def get_invite_link_repo(
    db: AsyncClient = Depends(get_firestore),
) -> InviteLinkRepository:
    return InviteLinkRepository(db)


def get_notification_repo(
    db: AsyncClient = Depends(get_firestore),
) -> NotificationRepository:
    return NotificationRepository(db)


def get_location_repo(
    db: AsyncClient = Depends(get_firestore),
) -> LocationRepository:
    return LocationRepository(db)


def get_chat_history_repo(gcs: GCSClient = Depends(get_gcs)) -> ChatHistoryRepository:
    return ChatHistoryRepository(gcs)


def get_preference_repo(
    db: AsyncClient = Depends(get_firestore),
) -> PreferenceRepository:
    return PreferenceRepository(db)


def get_action_repo(
    db: AsyncClient = Depends(get_firestore),
) -> ActionRepository:
    return ActionRepository(db)


def get_trip_service(
    trip_repo: TripRepository = Depends(get_trip_repo),
    plan_repo: PlanRepository = Depends(get_plan_repo),
    node_repo: NodeRepository = Depends(get_node_repo),
    edge_repo: EdgeRepository = Depends(get_edge_repo),
    action_repo: ActionRepository = Depends(get_action_repo),
    notification_repo: NotificationRepository = Depends(get_notification_repo),
    location_repo: LocationRepository = Depends(get_location_repo),
    invite_link_repo: InviteLinkRepository = Depends(get_invite_link_repo),
    preference_repo: PreferenceRepository = Depends(get_preference_repo),
) -> TripService:
    return TripService(
        trip_repo,
        plan_repo,
        node_repo,
        edge_repo,
        action_repo,
        notification_repo,
        location_repo,
        invite_link_repo,
        preference_repo,
    )


def get_route_service(request: Request) -> RouteService | None:
    """Return the shared RouteService from app state, or None if not initialised."""
    return getattr(request.app.state, "route_service", None)


def get_dag_service(
    request: Request,
    trip_repo: TripRepository = Depends(get_trip_repo),
    plan_repo: PlanRepository = Depends(get_plan_repo),
    node_repo: NodeRepository = Depends(get_node_repo),
    edge_repo: EdgeRepository = Depends(get_edge_repo),
) -> DAGService:
    route_service = get_route_service(request)
    return DAGService(trip_repo, plan_repo, node_repo, edge_repo, route_service=route_service)


def get_invite_service(
    invite_repo: InviteLinkRepository = Depends(get_invite_link_repo),
    trip_repo: TripRepository = Depends(get_trip_repo),
) -> InviteService:
    return InviteService(invite_repo, trip_repo)


def get_notification_service(
    notification_repo: NotificationRepository = Depends(get_notification_repo),
) -> NotificationService:
    return NotificationService(notification_repo)


def get_plan_service(
    trip_repo: TripRepository = Depends(get_trip_repo),
    plan_repo: PlanRepository = Depends(get_plan_repo),
    node_repo: NodeRepository = Depends(get_node_repo),
    edge_repo: EdgeRepository = Depends(get_edge_repo),
    notification_service: NotificationService = Depends(get_notification_service),
    action_repo: ActionRepository = Depends(get_action_repo),
) -> PlanService:
    return PlanService(
        trip_repo, plan_repo, node_repo, edge_repo, notification_service, action_repo
    )


def get_user_service(
    user_repo: UserRepository = Depends(get_user_repo),
) -> UserService:
    return UserService(user_repo)


def get_agent_service() -> AgentService:
    return AgentService()
