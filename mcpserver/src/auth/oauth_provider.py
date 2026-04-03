"""Minimal in-memory OAuth provider for FastMCP.

Satisfies the MCP SDK's OAuth2 discovery flow so that Claude Code (and other
MCP clients) mark the server as "authenticated" and expose tools.

The authorize step auto-approves — no browser interaction required.
load_access_token validates both OAuth-issued tokens AND direct API keys
(via HMAC-SHA256 + Firestore lookup), so `Authorization: Bearer <api_key>`
continues to work for deployed clients.
"""

from __future__ import annotations

import logging
import secrets
import time
from urllib.parse import urlencode

from google.cloud.firestore import AsyncClient
from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    OAuthAuthorizationServerProvider,
    OAuthClientInformationFull,
    OAuthToken,
    RefreshToken,
)

from mcpserver.src.auth.api_key_auth import resolve_user_from_api_key

logger = logging.getLogger(__name__)

# Token TTL
_ACCESS_TOKEN_TTL = 3600 * 24  # 24 hours
_AUTH_CODE_TTL = 300  # 5 minutes


class InMemoryOAuthProvider(
    OAuthAuthorizationServerProvider[AuthorizationCode, RefreshToken, AccessToken]
):
    """Auto-approving OAuth provider backed by in-memory dicts.

    Intended for local development with Claude Code. Not for production.
    """

    def __init__(self, db: AsyncClient, hmac_secret: str) -> None:
        self._db = db
        self._hmac_secret = hmac_secret
        self._clients: dict[str, OAuthClientInformationFull] = {}
        self._auth_codes: dict[str, AuthorizationCode] = {}
        self._tokens: dict[str, AccessToken] = {}
        self._refresh_tokens: dict[str, RefreshToken] = {}

    # --- Client registration ---

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        return self._clients.get(client_id)

    async def register_client(
        self, client_info: OAuthClientInformationFull
    ) -> None:
        if client_info.client_id:
            self._clients[client_info.client_id] = client_info

    # --- Authorization (auto-approve) ---

    async def authorize(
        self, client: OAuthClientInformationFull, params: AuthorizationParams
    ) -> str:
        code = secrets.token_urlsafe(32)
        self._auth_codes[code] = AuthorizationCode(
            code=code,
            scopes=params.scopes or [],
            expires_at=time.time() + _AUTH_CODE_TTL,
            client_id=client.client_id or "",
            code_challenge=params.code_challenge,
            redirect_uri=params.redirect_uri,
            redirect_uri_provided_explicitly=params.redirect_uri_provided_explicitly,
            resource=params.resource,
        )
        # Redirect immediately with the code — no user interaction.
        qs = urlencode({"code": code, **({"state": params.state} if params.state else {})})
        return f"{params.redirect_uri}?{qs}"

    # --- Token exchange ---

    async def load_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: str
    ) -> AuthorizationCode | None:
        return self._auth_codes.get(authorization_code)

    async def exchange_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: AuthorizationCode
    ) -> OAuthToken:
        # Remove used code
        self._auth_codes.pop(authorization_code.code, None)

        access = secrets.token_urlsafe(32)
        refresh = secrets.token_urlsafe(32)
        now = time.time()

        self._tokens[access] = AccessToken(
            token=access,
            client_id=client.client_id or "",
            scopes=authorization_code.scopes,
            expires_at=int(now + _ACCESS_TOKEN_TTL),
            resource=authorization_code.resource,
        )
        self._refresh_tokens[refresh] = RefreshToken(
            token=refresh,
            client_id=client.client_id or "",
            scopes=authorization_code.scopes,
            expires_at=int(now + _ACCESS_TOKEN_TTL * 7),
        )
        return OAuthToken(
            access_token=access,
            token_type="Bearer",
            expires_in=_ACCESS_TOKEN_TTL,
            refresh_token=refresh,
            scope=" ".join(authorization_code.scopes) if authorization_code.scopes else None,
        )

    # --- Refresh ---

    async def load_refresh_token(
        self, client: OAuthClientInformationFull, refresh_token: str
    ) -> RefreshToken | None:
        return self._refresh_tokens.get(refresh_token)

    async def exchange_refresh_token(
        self,
        client: OAuthClientInformationFull,
        refresh_token: RefreshToken,
        scopes: list[str],
    ) -> OAuthToken:
        self._refresh_tokens.pop(refresh_token.token, None)

        access = secrets.token_urlsafe(32)
        new_refresh = secrets.token_urlsafe(32)
        now = time.time()

        self._tokens[access] = AccessToken(
            token=access,
            client_id=client.client_id or "",
            scopes=scopes,
            expires_at=int(now + _ACCESS_TOKEN_TTL),
        )
        self._refresh_tokens[new_refresh] = RefreshToken(
            token=new_refresh,
            client_id=client.client_id or "",
            scopes=scopes,
            expires_at=int(now + _ACCESS_TOKEN_TTL * 7),
        )
        return OAuthToken(
            access_token=access,
            token_type="Bearer",
            expires_in=_ACCESS_TOKEN_TTL,
            refresh_token=new_refresh,
            scope=" ".join(scopes) if scopes else None,
        )

    # --- Token validation (OAuth tokens + direct API keys) ---

    async def load_access_token(self, token: str) -> AccessToken | None:
        # 1. Check in-memory OAuth tokens
        if token in self._tokens:
            stored = self._tokens[token]
            if stored.expires_at and time.time() > stored.expires_at:
                del self._tokens[token]
                return None
            return stored

        # 2. Fall back to API key validation (HMAC + Firestore)
        try:
            user_id = await resolve_user_from_api_key(
                self._db, token, self._hmac_secret
            )
            return AccessToken(
                token="<redacted>", client_id=user_id, scopes=[]
            )
        except PermissionError:
            return None

    # --- Revocation ---

    async def revoke_token(
        self, token: AccessToken | RefreshToken
    ) -> None:
        if isinstance(token, AccessToken):
            self._tokens.pop(token.token, None)
        elif isinstance(token, RefreshToken):
            self._refresh_tokens.pop(token.token, None)
