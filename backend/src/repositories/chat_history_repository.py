"""Chat history persistence in Google Cloud Storage."""

import json
import logging
import os
from datetime import UTC, datetime, timedelta

from google.cloud.storage import Client as GCSClient

SESSION_TTL_HOURS = 12
logger = logging.getLogger(__name__)


class ChatHistoryRepository:
    """Read/write agent chat history from GCS.

    Path: {bucket}/{user_id}/{trip_id}/chat-history.json
    Session TTL: 12 hours from last interaction.
    """

    def __init__(self, gcs_client: GCSClient):
        self._client = gcs_client
        self._bucket_name = os.getenv("GCS_CHAT_HISTORY_BUCKET", "smart-travel-buddy-chat")

    @property
    def _bucket(self):
        return self._client.bucket(self._bucket_name)

    def _blob_path(self, user_id: str, trip_id: str) -> str:
        return f"{user_id}/{trip_id}/chat-history.json"

    def _get_blob(self, user_id: str, trip_id: str):
        return self._bucket.blob(self._blob_path(user_id, trip_id))

    def load(self, user_id: str, trip_id: str) -> tuple[list[dict], bool]:
        """Load chat history. Returns (messages, is_new_session).

        If the file doesn't exist, the bucket is missing, or the session
        has expired (>12h since last interaction), returns an empty list
        with is_new_session=True.
        """
        try:
            blob = self._get_blob(user_id, trip_id)
            if not blob.exists():
                return [], True

            blob.reload()
            updated = blob.updated
            if updated and datetime.now(UTC) - updated > timedelta(hours=SESSION_TTL_HOURS):
                return [], True

            content = blob.download_as_text()
            messages = json.loads(content)
            return messages, False
        except Exception:
            logger.warning("Failed to load chat history, starting new session", exc_info=True)
            return [], True

    def save(self, user_id: str, trip_id: str, messages: list[dict]) -> None:
        """Save chat history to GCS, overwriting any existing file."""
        try:
            blob = self._get_blob(user_id, trip_id)
            blob.upload_from_string(
                json.dumps(messages, default=str),
                content_type="application/json",
            )
        except Exception:
            logger.warning("Failed to save chat history to GCS", exc_info=True)

    def delete(self, user_id: str, trip_id: str) -> None:
        """Delete chat history from GCS."""
        try:
            blob = self._get_blob(user_id, trip_id)
            if blob.exists():
                blob.delete()
        except Exception:
            logger.warning("Failed to delete chat history from GCS", exc_info=True)
