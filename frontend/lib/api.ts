"use client";

import { getFirebaseAuth } from "@/lib/firebase";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

async function getAuthToken(forceRefresh = false): Promise<string> {
  const auth = getFirebaseAuth();
  const user = auth.currentUser;
  if (!user) {
    throw new Error("Not authenticated");
  }
  return user.getIdToken(forceRefresh);
}

function buildHeaders(token: string, extra?: HeadersInit): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (extra) {
    const iter = new Headers(extra);
    iter.forEach((value, key) => {
      headers[key] = value;
    });
  }
  return headers;
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  const url = `${BACKEND_URL}/api/v1${path}`;

  let token = await getAuthToken();
  let res = await fetch(url, {
    ...options,
    headers: buildHeaders(token, options.headers),
    signal,
  });

  // On 401, force a token refresh and retry once. Stale ID tokens are the
  // most common cause of spurious 401s — Firebase caches the token for an
  // hour and getIdToken() only refreshes when asked.
  if (res.status === 401) {
    token = await getAuthToken(true);
    res = await fetch(url, {
      ...options,
      headers: buildHeaders(token, options.headers),
      signal,
    });
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message = body?.error?.message || `Request failed: ${res.status}`;
    throw new Error(message);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, {}, signal),

  post: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>(
      path,
      {
        method: "POST",
        body: body ? JSON.stringify(body) : undefined,
      },
      signal,
    ),

  patch: <T>(path: string, body: unknown, signal?: AbortSignal) =>
    request<T>(
      path,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      },
      signal,
    ),

  delete: <T>(path: string, signal?: AbortSignal) =>
    request<T>(path, { method: "DELETE" }, signal),
};
