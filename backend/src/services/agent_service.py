"""Gemini agent service for Magic Import and ongoing trip management."""

import json
import logging
import os
import time
import uuid
from datetime import UTC, datetime

from backend.src.services.agent_tools import create_agent_tools
from backend.src.services.agent_user_context import build_user_context, build_user_context_text
from backend.src.services.dag_service import DAGService
from backend.src.services.tool_executor import ToolExecutor
from google import genai
from google.genai import types

from shared.agent.config import (
    IMPORT_SYSTEM_PROMPT,
    ONGOING_RESPONSE_SCHEMA,
    ONGOING_SYSTEM_PROMPT,
    RESPONSE_SCHEMA,
)
from shared.agent.schemas import AgentReply, ImportChatResponse, OngoingChatResponse
from shared.dag.assembler import AssemblyResult, assemble_dag
from shared.models import Preference, PreferenceCategory, Trip

logger = logging.getLogger(__name__)


def build_trip_context(
    nodes: list[dict],
    edges: list[dict],
    preferences: list[dict],
) -> str:
    """Build a text summary of the current trip state for the agent.

    Used both for the initial system prompt context and by the get_plan
    tool to return a refreshed view after mutations.
    """
    from zoneinfo import ZoneInfo

    lines = ["Current trip stops:"]
    node_map = {n["id"]: n for n in nodes}
    sorted_nodes = sorted(nodes, key=lambda n: n.get("order_index", 0))
    for n in sorted_nodes:
        tz_str = n.get("timezone")
        tz = ZoneInfo(tz_str) if tz_str else None

        raw_arrival = n.get("arrival_time", "?")
        if tz and isinstance(raw_arrival, str) and raw_arrival != "?":
            try:
                dt = datetime.fromisoformat(raw_arrival)
                arrival = dt.astimezone(tz).strftime("%Y-%m-%d %H:%M %Z")
            except (ValueError, TypeError):
                arrival = raw_arrival
        else:
            arrival = raw_arrival

        raw_departure = n.get("departure_time", "")
        if tz and isinstance(raw_departure, str) and raw_departure:
            try:
                dt = datetime.fromisoformat(raw_departure)
                departure = dt.astimezone(tz).strftime("%Y-%m-%d %H:%M %Z")
            except (ValueError, TypeError):
                departure = raw_departure
        else:
            departure = raw_departure

        dep_str = f" - depart: {departure}" if departure else ""
        tz_label = f", tz: {tz_str}" if tz_str else ""
        lines.append(f"  - [{n['id']}] {n['name']} ({n.get('type', 'place')}{tz_label})"
                     f" arrive: {arrival}{dep_str}")

    if edges:
        lines.append("\nConnections:")
        for e in edges:
            from_name = node_map.get(e["from_node_id"], {}).get("name", e["from_node_id"])
            to_name = node_map.get(e["to_node_id"], {}).get("name", e["to_node_id"])
            lines.append(
                f"  - {from_name} -> {to_name}"
                f" ({e.get('travel_mode', 'drive')}, {e.get('travel_time_hours', 0)}h)"
            )

    if preferences:
        lines.append("\nTravel preferences:")
        for p in preferences:
            lines.append(f"  - [{p.get('category', 'general')}] {p.get('content', '')}")

    return "\n".join(lines)


class AgentService:
    """Manages Gemini chat sessions for trip import and ongoing management."""

    def __init__(self):
        self._client = genai.Client(
            vertexai=True,
            project=os.getenv("GOOGLE_CLOUD_PROJECT"),
            location=os.getenv("GOOGLE_CLOUD_LOCATION", "global"),
        )
        self._model = os.getenv("GEMINI_MODEL", "gemini-3-flash-preview")

    async def import_chat(
        self, messages: list[dict]
    ) -> ImportChatResponse:
        """Send messages to the Gemini import agent and get structured response.

        The frontend sends the full conversation history on each request.
        Gemini processes the full context and returns the next response.
        """
        start = time.perf_counter()
        gemini_contents = []
        for msg in messages:
            role = "user" if msg["role"] == "user" else "model"
            gemini_contents.append(
                types.Content(
                    role=role,
                    parts=[types.Part.from_text(text=msg["content"])],
                )
            )

        response = await self._client.aio.models.generate_content(
            model=self._model,
            contents=gemini_contents,
            config=types.GenerateContentConfig(
                system_instruction=IMPORT_SYSTEM_PROMPT,
                response_mime_type="application/json",
                response_schema=RESPONSE_SCHEMA,
                tools=[
                    types.Tool(google_maps=types.GoogleMaps()),
                    types.Tool(google_search=types.GoogleSearch()),
                ],
            ),
        )

        response_text = response.text
        parsed = ImportChatResponse.model_validate_json(response_text)
        elapsed = time.perf_counter() - start
        logger.info("import_chat completed in %.2fs", elapsed)
        return parsed

    async def build_dag(
        self,
        messages: list[dict],
        created_by: str,
    ) -> AssemblyResult:
        """Extract final trip plan from conversation and assemble into DAG.

        Asks Gemini to produce a structured list of locations with coordinates,
        then passes them through the DAG assembler.
        """
        start = time.perf_counter()
        build_prompt = (
            "Based on our conversation, produce a JSON array of the trip stops.\n\n"
            "Follow these steps:\n\n"
            "STEP 1 — List the LINEAR SPINE stops first.\n"
            "These are stops the whole group visits together, in chronological order. "
            "For each stop include: name (string), lat (number), lng (number), "
            "place_id (string or null), duration_hours (number), "
            "travel_time_hours (number — hours to reach THIS stop from the previous one), "
            "distance_km (number or null).\n\n"
            "STEP 2 — Insert BRANCH stops right after the spine stop they split from.\n"
            "When the group splits up, add the parallel stops with these EXTRA fields:\n"
            "- branch_group (string): a shared label for all stops in the same split\n"
            "- connects_from (string): the exact NAME of the spine stop where the group "
            "splits apart\n"
            "- connects_to (string or null): the exact NAME of the spine stop where the "
            "group meets back up, or null if they don't reconvene\n"
            "- participant_names (array of strings or null): who goes to this stop\n"
            "- travel_time_hours on branch stops = travel FROM the connects_from stop\n"
            "- distance_km on branch stops = distance FROM the connects_from stop\n\n"
            "RULES:\n"
            "- Spine stops have NO branch_group field.\n"
            "- All branch stops in the same split share the same branch_group label.\n"
            "- connects_from and connects_to must exactly match the name of a spine stop.\n\n"
            "EXAMPLE — A road trip where the group splits after Denver:\n"
            "[\n"
            '  {"name": "Denver", "lat": 39.74, "lng": -104.99, "place_id": null, '
            '"duration_hours": 48, "travel_time_hours": 0, "distance_km": null},\n'
            '  {"name": "Moab", "lat": 38.57, "lng": -109.55, "place_id": null, '
            '"duration_hours": 48, "travel_time_hours": 5.5, "distance_km": 350, '
            '"branch_group": "co_split", "connects_from": "Denver", '
            '"connects_to": "Salt Lake City", "participant_names": ["Alice"]},\n'
            '  {"name": "Aspen", "lat": 39.19, "lng": -106.82, "place_id": null, '
            '"duration_hours": 48, "travel_time_hours": 3.5, "distance_km": 260, '
            '"branch_group": "co_split", "connects_from": "Denver", '
            '"connects_to": "Salt Lake City", "participant_names": ["Bob"]},\n'
            '  {"name": "Salt Lake City", "lat": 40.76, "lng": -111.89, '
            '"place_id": null, "duration_hours": 48, "travel_time_hours": 6, '
            '"distance_km": 525}\n'
            "]\n\n"
            "Notice: the two branch stops (Moab, Aspen) both reference "
            '"Denver" as connects_from and "Salt Lake City" as connects_to.\n\n'
            "Use your best estimates for coordinates and travel times.\n"
            "Return ONLY the JSON array, no other text."
        )

        gemini_contents = []
        for msg in messages:
            role = "user" if msg["role"] == "user" else "model"
            gemini_contents.append(
                types.Content(
                    role=role,
                    parts=[types.Part.from_text(text=msg["content"])],
                )
            )
        gemini_contents.append(
            types.Content(
                role="user",
                parts=[types.Part.from_text(text=build_prompt)],
            )
        )

        response = await self._client.aio.models.generate_content(
            model=self._model,
            contents=gemini_contents,
            config=types.GenerateContentConfig(
                system_instruction=IMPORT_SYSTEM_PROMPT,
                response_mime_type="application/json",
                tools=[
                    types.Tool(google_maps=types.GoogleMaps()),
                    types.Tool(google_search=types.GoogleSearch()),
                ],
            ),
        )

        locations = json.loads(response.text)
        if not isinstance(locations, list):
            locations = []

        # Extract notes from the last import_chat response for reference

        result = assemble_dag(
            notes=[],
            geocoded_locations=locations,
            created_by=created_by,
        )
        elapsed = time.perf_counter() - start
        logger.info(
            "build_dag completed in %.2fs (%d nodes, %d edges)",
            elapsed, len(result.nodes), len(result.edges),
        )
        return result

    async def ongoing_chat(
        self,
        message: str,
        history: list[dict],
        nodes: list[dict],
        edges: list[dict],
        preferences: list[dict],
        dag_service: DAGService,
        trip_id: str,
        plan_id: str,
        user_id: str,
        trip: Trip,
        display_name: str,
    ) -> OngoingChatResponse:
        """Send a message to the ongoing trip management agent.

        Uses Gemini's Automatic Function Calling (AFC) to execute DAG
        operations. The SDK handles the function calling loop — no manual
        loop needed. Tool functions are async callables that delegate to
        ToolExecutor, which dispatches to DAGService.
        """
        start = time.perf_counter()
        trip_context = build_trip_context(nodes, edges, preferences)
        user_ctx = build_user_context(trip, user_id, display_name, nodes, edges)
        user_context_text = build_user_context_text(user_ctx)
        system_prompt = ONGOING_SYSTEM_PROMPT + "\n\n" + trip_context + "\n\n" + user_context_text

        gemini_contents = []
        for msg in history:
            role = "user" if msg["role"] == "user" else "model"
            gemini_contents.append(
                types.Content(
                    role=role,
                    parts=[types.Part.from_text(text=msg["content"])],
                )
            )
        gemini_contents.append(
            types.Content(
                role="user",
                parts=[types.Part.from_text(text=message)],
            )
        )

        # Create tool executor and callable tools for this request
        executor = ToolExecutor(dag_service, trip_id, plan_id, user_id, preferences)
        tools = create_agent_tools(executor, can_mutate=user_ctx.can_mutate)

        response = await self._client.aio.models.generate_content(
            model=self._model,
            contents=gemini_contents,
            config=types.GenerateContentConfig(
                system_instruction=system_prompt,
                response_mime_type="application/json",
                response_schema=ONGOING_RESPONSE_SCHEMA,
                tools=[
                    types.Tool(google_maps=types.GoogleMaps()),
                    types.Tool(google_search=types.GoogleSearch()),
                    *tools,
                ],
                automatic_function_calling=types.AutomaticFunctionCallingConfig(
                    maximum_remote_calls=50,
                ),
            ),
        )

        # Parse structured reply (AgentReply: reply + preferences_extracted)
        try:
            agent_reply = AgentReply.model_validate_json(response.text)
            reply = agent_reply.reply
            preferences_extracted = agent_reply.preferences_extracted
        except Exception:
            # Fallback: use raw text if structured parsing fails
            logger.warning("Failed to parse AgentReply, using raw text", exc_info=True)
            reply = response.text or "I wasn't able to generate a response."
            preferences_extracted = []

        elapsed = time.perf_counter() - start
        logger.info(
            "ongoing_chat completed in %.2fs (%d actions taken)",
            elapsed, len(executor.actions_taken),
        )
        return OngoingChatResponse(
            reply=reply,
            actions_taken=executor.actions_taken,
            preferences_extracted=preferences_extracted,
        )

    @staticmethod
    def extract_preferences(
        response: OngoingChatResponse,
        user_id: str,
    ) -> list[Preference]:
        """Convert extracted preferences from the agent response into Preference models."""
        result = []
        for p in response.preferences_extracted:
            try:
                category = PreferenceCategory(p.category)
            except ValueError:
                category = PreferenceCategory.GENERAL
            result.append(Preference(
                id=str(uuid.uuid4()),
                content=p.content,
                category=category,
                extracted_from="agent_chat",
                created_by=user_id,
                created_at=datetime.now(UTC),
            ))
        return result
