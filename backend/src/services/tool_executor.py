"""Tool executor: dispatches agent tool calls to DAGService methods."""

import logging

from backend.src.services.dag_service import DAGService

from shared.agent.schemas import ActionTaken

logger = logging.getLogger(__name__)


class ToolExecutor:
    """Executes DAG tool calls and tracks actions taken.

    Constructed per-request with the current trip context. The agent_tools
    module creates async callables that delegate to this executor.
    """

    def __init__(
        self,
        dag_service: DAGService,
        trip_id: str,
        plan_id: str,
        user_id: str,
        preferences: list[dict] | None = None,
    ):
        self._dag = dag_service
        self._trip_id = trip_id
        self._plan_id = plan_id
        self._user_id = user_id
        self._preferences: list[dict] = preferences or []
        self.actions_taken: list[ActionTaken] = []

    async def execute(self, name: str, args: dict) -> dict:
        """Dispatch a tool call to the corresponding DAGService method.

        Returns a result dict on success or an error dict on failure.
        Errors are returned (not raised) so the SDK sends them back to
        Gemini, allowing the agent to inform the user gracefully.
        """
        try:
            handler = getattr(self, f"_handle_{name}", None)
            if handler is None:
                return {"error": f"Unknown tool: {name}"}
            return await handler(args)
        except Exception as e:
            logger.warning("Tool %s failed: %s", name, e, exc_info=True)
            return {"error": str(e)}

    async def _handle_get_plan(self, args: dict) -> dict:
        """Fetch fresh plan state and return a text summary."""
        from backend.src.services.agent_service import build_trip_context

        dag = await self._dag.get_full_dag(self._trip_id, self._plan_id)
        summary = build_trip_context(
            dag["nodes"], dag["edges"], self._preferences
        )
        return {"plan_summary": summary}

    async def _handle_add_node(self, args: dict) -> dict:
        result = await self._dag.create_node(
            trip_id=self._trip_id,
            plan_id=self._plan_id,
            name=args["name"],
            node_type=args["type"],
            lat=args["lat"],
            lng=args["lng"],
            connect_after_node_id=args.get("connect_after_node_id"),
            travel_mode=args.get("travel_mode", "drive"),
            travel_time_hours=args.get("travel_time_hours", 0),
            distance_km=args.get("distance_km"),
            created_by=self._user_id,
            place_id=args.get("place_id"),
            arrival_time=args.get("arrival_time"),
            departure_time=args.get("departure_time"),
        )
        node = result["node"]
        self.actions_taken.append(ActionTaken(
            type="node_added",
            node_id=node["id"],
            description=f"Added stop: {node['name']}",
        ))
        return result

    async def _handle_update_node(self, args: dict) -> dict:
        node_id = args["node_id"]
        updates = {k: v for k, v in args.items() if k != "node_id" and v is not None}

        # Rename 'type' to match Firestore field name
        if "type" in updates:
            updates["type"] = updates["type"]

        result = await self._dag.update_node_with_cascade_preview(
            trip_id=self._trip_id,
            plan_id=self._plan_id,
            node_id=node_id,
            updates=updates,
        )

        # Auto-confirm cascade since the user already confirmed in chat
        cascade = result.get("cascade_preview", {})
        affected = cascade.get("affected_nodes", [])
        if affected:
            await self._dag.confirm_cascade(
                trip_id=self._trip_id,
                plan_id=self._plan_id,
                node_id=node_id,
            )

        node = result["node"]
        description = f"Updated stop: {node.get('name', node_id)}"
        if affected:
            description += f" (cascaded to {len(affected)} downstream nodes)"

        self.actions_taken.append(ActionTaken(
            type="node_updated",
            node_id=node_id,
            description=description,
        ))
        return result

    async def _handle_delete_node(self, args: dict) -> dict:
        node_id = args["node_id"]
        name = await self._resolve_node_name(node_id)
        result = await self._dag.delete_node(
            trip_id=self._trip_id,
            plan_id=self._plan_id,
            node_id=node_id,
        )
        self.actions_taken.append(ActionTaken(
            type="node_deleted",
            node_id=node_id,
            description=f"Removed stop: {name}",
        ))
        return result

    async def _handle_add_edge(self, args: dict) -> dict:
        from_name = await self._resolve_node_name(args["from_node_id"])
        to_name = await self._resolve_node_name(args["to_node_id"])
        result = await self._dag.create_standalone_edge(
            trip_id=self._trip_id,
            plan_id=self._plan_id,
            from_node_id=args["from_node_id"],
            to_node_id=args["to_node_id"],
            travel_mode=args.get("travel_mode", "drive"),
            travel_time_hours=args.get("travel_time_hours", 0),
            distance_km=args.get("distance_km"),
        )
        self.actions_taken.append(ActionTaken(
            type="edge_added",
            node_id=None,
            description=f"Connected {from_name} to {to_name}",
        ))
        return result

    async def _handle_delete_edge(self, args: dict) -> dict:
        edge_id = args["edge_id"]
        # Look up edge to get node names before deleting
        edge_data = await self._dag._edge_repo.get(
            edge_id, trip_id=self._trip_id, plan_id=self._plan_id,
        )
        if edge_data:
            from_name = await self._resolve_node_name(edge_data.get("from_node_id", ""))
            to_name = await self._resolve_node_name(edge_data.get("to_node_id", ""))
            desc = f"Removed connection between {from_name} and {to_name}"
        else:
            desc = "Removed connection"
        result = await self._dag.delete_edge_by_id(
            trip_id=self._trip_id,
            plan_id=self._plan_id,
            edge_id=edge_id,
        )
        self.actions_taken.append(ActionTaken(
            type="edge_deleted",
            node_id=None,
            description=desc,
        ))
        return result

    async def _resolve_node_name(self, node_id: str) -> str:
        """Look up a node's name by ID, returning the ID as fallback."""
        try:
            data = await self._dag._node_repo.get(
                node_id, trip_id=self._trip_id, plan_id=self._plan_id,
            )
            return data.get("name", node_id) if data else node_id
        except Exception:
            return node_id
