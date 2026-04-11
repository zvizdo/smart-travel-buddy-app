import asyncio

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from firebase_admin import auth

security = HTTPBearer()


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> dict:
    """Verify Firebase ID token and return decoded token claims.

    Catches only the specific Firebase auth errors we understand — invalid,
    expired, or revoked tokens. Anything else (misconfiguration, transient
    Google network issues) bubbles up and is handled by the generic 500
    exception handler in main.py rather than being silently remapped to 401.
    """
    try:
        decoded_token = await asyncio.to_thread(
            auth.verify_id_token, credentials.credentials
        )
        return decoded_token
    except auth.InvalidIdTokenError as exc:
        raise HTTPException(
            status_code=401,
            detail={"error": {"code": "UNAUTHORIZED", "message": "Invalid ID token"}},
        ) from exc
    except auth.ExpiredIdTokenError as exc:
        raise HTTPException(
            status_code=401,
            detail={"error": {"code": "UNAUTHORIZED", "message": "Expired ID token"}},
        ) from exc
    except auth.RevokedIdTokenError as exc:
        raise HTTPException(
            status_code=401,
            detail={"error": {"code": "UNAUTHORIZED", "message": "Revoked ID token"}},
        ) from exc
