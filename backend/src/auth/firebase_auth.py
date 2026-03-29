import asyncio

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from firebase_admin import auth

security = HTTPBearer()


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> dict:
    """Verify Firebase ID token and return decoded token claims."""
    try:
        decoded_token = await asyncio.to_thread(
            auth.verify_id_token, credentials.credentials
        )
        return decoded_token
    except auth.InvalidIdTokenError:
        raise HTTPException(
            status_code=401,
            detail={"error": {"code": "UNAUTHORIZED", "message": "Invalid ID token"}},
        )
    except auth.ExpiredIdTokenError:
        raise HTTPException(
            status_code=401,
            detail={"error": {"code": "UNAUTHORIZED", "message": "Expired ID token"}},
        )
    except Exception:
        raise HTTPException(
            status_code=401,
            detail={
                "error": {"code": "UNAUTHORIZED", "message": "Could not verify token"}
            },
        )
