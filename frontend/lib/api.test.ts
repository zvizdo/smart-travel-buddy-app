import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mockGetIdToken = vi.fn();

vi.mock("@/lib/firebase", () => ({
  getFirebaseAuth: () => ({
    currentUser: {
      getIdToken: mockGetIdToken,
    },
  }),
}));

interface MockResponseInit {
  status?: number;
  ok?: boolean;
  body?: unknown;
}

function mockFetchOnce(init: MockResponseInit): Response {
  return {
    ok: init.ok ?? (init.status ? init.status >= 200 && init.status < 300 : true),
    status: init.status ?? 200,
    json: async () => init.body ?? null,
  } as unknown as Response;
}

describe("api client", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockGetIdToken.mockReset();
    global.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("injects Bearer token on every request", async () => {
    mockGetIdToken.mockResolvedValue("token-1");
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockFetchOnce({ status: 200, body: { foo: "bar" } }),
    );

    const { api } = await import("./api");
    const result = await api.get<{ foo: string }>("/test");

    expect(result).toEqual({ foo: "bar" });
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].headers.Authorization).toBe("Bearer token-1");
    expect(call[1].headers["Content-Type"]).toBe("application/json");
  });

  // Regression: Firebase caches ID tokens for an hour, so stale tokens
  // surface as opaque 401s with no recovery. The client must force-refresh
  // once on 401 and retry the original request before bubbling up.
  it("retries once with a force-refreshed token on 401", async () => {
    mockGetIdToken
      .mockResolvedValueOnce("stale-token")
      .mockResolvedValueOnce("fresh-token");

    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockFetchOnce({ status: 401, ok: false }))
      .mockResolvedValueOnce(mockFetchOnce({ status: 200, body: { ok: true } }));

    const { api } = await import("./api");
    const result = await api.get<{ ok: boolean }>("/test");

    expect(result).toEqual({ ok: true });
    expect(mockGetIdToken).toHaveBeenCalledTimes(2);
    // First call uses cached token (forceRefresh defaults to false).
    // Second call forces a refresh via the `true` arg.
    expect(mockGetIdToken).toHaveBeenNthCalledWith(1, false);
    expect(mockGetIdToken).toHaveBeenNthCalledWith(2, true);

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][1].headers.Authorization).toBe("Bearer stale-token");
    expect(calls[1][1].headers.Authorization).toBe("Bearer fresh-token");
  });

  it("does NOT retry more than once — second 401 bubbles up", async () => {
    mockGetIdToken.mockResolvedValue("token");
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(
        mockFetchOnce({ status: 401, ok: false, body: { error: { message: "nope" } } }),
      )
      .mockResolvedValueOnce(
        mockFetchOnce({ status: 401, ok: false, body: { error: { message: "still nope" } } }),
      );

    const { api } = await import("./api");
    await expect(api.get("/test")).rejects.toThrow("still nope");
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it("does not retry on non-401 errors", async () => {
    mockGetIdToken.mockResolvedValue("token");
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockFetchOnce({ status: 500, ok: false, body: { error: { message: "boom" } } }),
    );

    const { api } = await import("./api");
    await expect(api.get("/test")).rejects.toThrow("boom");
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect(mockGetIdToken).toHaveBeenCalledTimes(1);
  });

  it("forwards AbortSignal to fetch on every verb", async () => {
    mockGetIdToken.mockResolvedValue("token");
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockFetchOnce({ status: 200, body: {} }),
    );

    const { api } = await import("./api");
    const controller = new AbortController();

    await api.get("/g", controller.signal);
    await api.post("/p", { x: 1 }, controller.signal);
    await api.patch("/pa", { x: 1 }, controller.signal);
    await api.delete("/d", controller.signal);

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call[1].signal).toBe(controller.signal);
    }
  });

  it("forwards the retry with the same AbortSignal", async () => {
    mockGetIdToken
      .mockResolvedValueOnce("stale")
      .mockResolvedValueOnce("fresh");
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockFetchOnce({ status: 401, ok: false }))
      .mockResolvedValueOnce(mockFetchOnce({ status: 200, body: {} }));

    const { api } = await import("./api");
    const controller = new AbortController();
    await api.get("/test", controller.signal);

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][1].signal).toBe(controller.signal);
    expect(calls[1][1].signal).toBe(controller.signal);
  });

  it("returns undefined on 204 No Content", async () => {
    mockGetIdToken.mockResolvedValue("token");
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => {
        throw new Error("should not be called");
      },
    } as unknown as Response);

    const { api } = await import("./api");
    const result = await api.delete<undefined>("/test");
    expect(result).toBeUndefined();
  });

  it("throws when auth.currentUser is null", async () => {
    // Re-mock firebase with no user
    vi.doMock("@/lib/firebase", () => ({
      getFirebaseAuth: () => ({ currentUser: null }),
    }));
    vi.resetModules();
    const { api } = await import("./api");
    await expect(api.get("/test")).rejects.toThrow("Not authenticated");
    vi.doUnmock("@/lib/firebase");
    vi.resetModules();
  });
});
