from abc import ABC, abstractmethod
from typing import Any

from google.cloud.firestore import AsyncClient
from pydantic import BaseModel


class BaseRepository(ABC):
    """Abstract base class for Firestore repositories."""

    def __init__(self, db: AsyncClient):
        self._db = db

    @property
    @abstractmethod
    def collection_path(self) -> str:
        """Return the Firestore collection path."""
        ...

    def _collection(self, **path_params: str):
        """Get a collection reference, formatting path with params."""
        return self._db.collection(self.collection_path.format(**path_params))

    async def create(self, data: BaseModel, **path_params: str) -> dict[str, Any]:
        """Create a document with the model's id field as the document ID."""
        doc_dict = data.model_dump(mode="json")
        doc_ref = self._collection(**path_params).document(data.id)
        await doc_ref.set(doc_dict)
        return doc_dict

    async def get(self, doc_id: str, **path_params: str) -> dict[str, Any] | None:
        """Get a document by ID. Returns None if not found."""
        doc = await self._collection(**path_params).document(doc_id).get()
        return doc.to_dict() if doc.exists else None

    async def get_or_raise(self, doc_id: str, **path_params: str) -> dict[str, Any]:
        """Get a document by ID. Raises LookupError if not found."""
        result = await self.get(doc_id, **path_params)
        if result is None:
            raise LookupError(f"Document {doc_id} not found")
        return result

    async def update(
        self, doc_id: str, updates: dict[str, Any], **path_params: str
    ) -> None:
        """Update specific fields on a document."""
        await self._collection(**path_params).document(doc_id).update(updates)

    async def delete(self, doc_id: str, **path_params: str) -> None:
        """Delete a document by ID."""
        await self._collection(**path_params).document(doc_id).delete()

    async def list_all(self, **path_params: str) -> list[dict[str, Any]]:
        """List all documents in the collection."""
        docs = self._collection(**path_params).stream()
        return [doc.to_dict() async for doc in docs]
