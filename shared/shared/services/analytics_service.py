"""GA4 Measurement Protocol client for server-side analytics.

Used by the MCP server to fire `mcp_tool_called` events when external AI
agents invoke tools. The web app sends its own events via the Firebase
Analytics SDK — this service exists purely for server-originated events.

Fire-and-forget semantics: every send is wrapped so failures log at WARNING
but never propagate. No measurement_id / api_secret → no-op. This mirrors
the frontend's `NoopAnalyticsClient` pattern so missing env vars produce
zero network traffic and zero errors.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_GA4_ENDPOINT = "https://www.google-analytics.com/mp/collect"
_TIMEOUT_SECONDS = 5.0


class AnalyticsService:
    """Sends GA4 Measurement Protocol events from server-side code."""

    def __init__(
        self,
        http_client: httpx.AsyncClient,
        measurement_id: str | None,
        api_secret: str | None,
    ) -> None:
        self._http = http_client
        self._measurement_id = measurement_id or None
        self._api_secret = api_secret or None

    @property
    def enabled(self) -> bool:
        """True when both env vars are set — gate for callers that want to
        skip building event params for no-op sends."""
        return bool(self._measurement_id and self._api_secret)

    async def track_event(
        self,
        user_id: str,
        event_name: str,
        params: dict[str, Any] | None = None,
        analytics_enabled: bool = True,
    ) -> None:
        """Fire a GA4 event for ``user_id``. Never raises."""
        if not self.enabled:
            return
        if not analytics_enabled:
            return
        if not user_id:
            logger.warning("AnalyticsService.track_event called without user_id")
            return

        payload = {
            "client_id": user_id,
            "user_id": user_id,
            "events": [
                {
                    "name": event_name,
                    "params": _clean_params(params or {}),
                },
            ],
        }

        try:
            await self._http.post(
                _GA4_ENDPOINT,
                params={
                    "measurement_id": self._measurement_id,
                    "api_secret": self._api_secret,
                },
                json=payload,
                timeout=_TIMEOUT_SECONDS,
            )
        except Exception as exc:
            logger.warning(
                "GA4 track_event failed for %s: %s", event_name, exc,
            )


def _clean_params(params: dict[str, Any]) -> dict[str, Any]:
    """Drop None values — GA4 rejects null params and they carry no signal."""
    return {k: v for k, v in params.items() if v is not None}
