"""Gemini agent service for Magic Import and ongoing trip management."""

import logging
import os
import time
from datetime import UTC, datetime

from backend.src.services.agent_tools import (
    create_agent_tools,
    create_build_tools,
    create_search_tools,
)
from backend.src.services.agent_user_context import build_user_context, build_user_context_text
from backend.src.services.tool_executor import ToolExecutor
from google import genai
from google.genai import types

from shared.agent.config import (
    BUILD_RESPONSE_SCHEMA,
    BUILD_SYSTEM_PROMPT,
    IMPORT_SYSTEM_PROMPT,
    ONGOING_RESPONSE_SCHEMA,
    ONGOING_SYSTEM_PROMPT,
    RESPONSE_SCHEMA,
)
from shared.agent.schemas import (
    AgentReply,
    BuildDagReply,
    BuildDagResponse,
    ImportChatResponse,
    OngoingChatResponse,
)
from shared.models import Preference, PreferenceCategory, Trip
from shared.services.dag_service import DAGService
from shared.services.flight_service import FlightService
from shared.tools.id_gen import generate_id
from shared.tools.trip_context import build_agent_trip_context

logger = logging.getLogger(__name__)


def _extract_response_text(response) -> str:
    """Concatenate text parts from the first candidate.

    Equivalent to ``response.text`` but without the SDK warning that fires
    when the final candidate contains unexecuted ``function_call`` parts
    (AFC hit its call cap or the model mixed text + function_call in the
    last turn). Logs any pending function calls so we notice if it recurs.
    """
    if not response.candidates:
        return ""
    parts = response.candidates[0].content.parts or []
    pending = [
        p.function_call.name for p in parts if getattr(p, "function_call", None)
    ]
    if pending:
        logger.warning(
            "Agent response contained %d unexecuted function_call part(s): %s",
            len(pending), pending,
        )
    return "".join(p.text for p in parts if getattr(p, "text", None))


def build_trip_context(
    nodes: list[dict],
    edges: list[dict],
    preferences: list[dict],
    trip_settings: dict | None = None,
) -> str:
    """Build a text summary of the current trip state for the agent.

    Runs ``enrich_dag_times`` first so the agent sees the same propagated /
    estimated times the UI does, then renders the markdown view. Used both
    for the initial system prompt context and by the get_plan tool to
    return a refreshed view after mutations.
    """
    return build_agent_trip_context(
        nodes, edges, trip_settings, preferences=preferences
    )


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
        self, messages: list[dict], flight_service: FlightService | None = None
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

        search_tools = create_search_tools(flight_service) if flight_service else []

        response = await self._client.aio.models.generate_content(
            model=self._model,
            contents=gemini_contents,
            config=types.GenerateContentConfig(
                system_instruction=IMPORT_SYSTEM_PROMPT,
                response_mime_type="application/json",
                response_schema=RESPONSE_SCHEMA,
                thinking_config=types.ThinkingConfig(
                    thinking_level=types.ThinkingLevel.HIGH
                ),
                tools=[
                    types.Tool(google_maps=types.GoogleMaps()),
                    types.Tool(google_search=types.GoogleSearch()),
                    *search_tools,
                ],
                automatic_function_calling=types.AutomaticFunctionCallingConfig(
                    maximum_remote_calls=10,
                ) if search_tools else None,
            ),
        )

        response_text = _extract_response_text(response) if search_tools else response.text
        parsed = ImportChatResponse.model_validate_json(response_text)
        elapsed = time.perf_counter() - start
        logger.info("import_chat completed in %.2fs", elapsed)
        return parsed

    async def build_dag(
        self,
        messages: list[dict],
        dag_service: DAGService,
        trip_id: str,
        plan_id: str,
        user_id: str,
    ) -> BuildDagResponse:
        """Build the trip DAG using tool calls (AFC).

        Instead of asking Gemini for a JSON array and assembling it, the agent
        uses add_node, add_edge, and get_plan tools to construct the DAG
        step-by-step, verifying its work as it goes.
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
        gemini_contents.append(
            types.Content(
                role="user",
                parts=[types.Part.from_text(
                    text="Build the trip plan now based on our conversation.",
                )],
            )
        )

        executor = ToolExecutor(dag_service, trip_id, plan_id, user_id)
        tools = create_build_tools(executor)

        response = await self._client.aio.models.generate_content(
            model=self._model,
            contents=gemini_contents,
            config=types.GenerateContentConfig(
                system_instruction=BUILD_SYSTEM_PROMPT,
                response_mime_type="application/json",
                response_schema=BUILD_RESPONSE_SCHEMA,
                thinking_config=types.ThinkingConfig(
                    thinking_level=types.ThinkingLevel.HIGH
                ),
                tools=[
                    types.Tool(google_maps=types.GoogleMaps()),
                    types.Tool(google_search=types.GoogleSearch()),
                    *tools,
                ],
                automatic_function_calling=types.AutomaticFunctionCallingConfig(
                    maximum_remote_calls=256,
                ),
            ),
        )

        # Derive node/edge counts from the executor's recorded actions — this
        # is the source of truth regardless of whether the structured reply
        # parses. If the LLM echoes different counts in its JSON we still
        # trust what actually hit Firestore.
        node_count = sum(1 for a in executor.actions_taken if a.type == "node_added")
        edge_count = sum(1 for a in executor.actions_taken if a.type == "edge_added")
        response_text = _extract_response_text(response)
        try:
            reply = BuildDagReply.model_validate_json(response_text)
            summary = reply.summary
        except Exception:
            logger.warning("Failed to parse BuildDagReply, using raw text", exc_info=True)
            summary = response_text or "Trip built."

        elapsed = time.perf_counter() - start
        logger.info(
            "build_dag completed in %.2fs (%d actions taken)",
            elapsed, len(executor.actions_taken),
        )
        return BuildDagResponse(
            summary=summary,
            actions_taken=executor.actions_taken,
            node_count=node_count,
            edge_count=edge_count,
        )

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
        flight_service: FlightService | None = None,
    ) -> OngoingChatResponse:
        """Send a message to the ongoing trip management agent.

        Uses Gemini's Automatic Function Calling (AFC) to execute DAG
        operations. The SDK handles the function calling loop — no manual
        loop needed. Tool functions are async callables that delegate to
        ToolExecutor, which dispatches to DAGService.
        """
        start = time.perf_counter()
        trip_settings_dict = trip.settings.model_dump(mode="json") if trip.settings else {}
        trip_context = build_trip_context(nodes, edges, preferences, trip_settings_dict)
        user_ctx = build_user_context(trip, user_id, display_name, nodes, edges, plan_id, trip.active_plan_id)
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
        executor = ToolExecutor(
            dag_service, trip_id, plan_id, user_id,
            preferences=preferences,
            trip_settings=trip_settings_dict,
        )
        tools = create_agent_tools(executor, can_mutate=user_ctx.can_mutate)
        if flight_service:
            tools.extend(create_search_tools(flight_service))

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
                    maximum_remote_calls=100,
                ),
            ),
        )

        # Parse structured reply (AgentReply: reply + preferences_extracted)
        response_text = _extract_response_text(response)
        try:
            agent_reply = AgentReply.model_validate_json(response_text)
            reply = agent_reply.reply
            preferences_extracted = agent_reply.preferences_extracted
        except Exception:
            # Fallback: use raw text if structured parsing fails
            logger.warning("Failed to parse AgentReply, using raw text", exc_info=True)
            reply = response_text or "I wasn't able to generate a response."
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
                id=generate_id("prf"),
                content=p.content,
                category=category,
                extracted_from="agent_chat",
                created_by=user_id,
                created_at=datetime.now(UTC),
            ))
        return result
