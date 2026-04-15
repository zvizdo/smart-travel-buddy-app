import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetAnalyticsClientForTests, type AnalyticsClient } from "./client";

function makeMockClient(): AnalyticsClient {
  return {
    logEvent: vi.fn(),
    setUserId: vi.fn(),
    setUserProperties: vi.fn(),
    setEnabled: vi.fn(),
    isEnabled: () => true,
  };
}

describe("analytics event helpers", () => {
  let client: AnalyticsClient;

  beforeEach(() => {
    client = makeMockClient();
    __resetAnalyticsClientForTests(client);
  });

  it("trackDagMutation forwards name + params", async () => {
    const { trackDagMutation } = await import("./events");
    trackDagMutation({
      source: "ui",
      action: "create",
      entity: "node",
      node_type: "hotel",
    });
    expect(client.logEvent).toHaveBeenCalledWith("dag_mutation", {
      source: "ui",
      action: "create",
      entity: "node",
      node_type: "hotel",
    });
  });

  it("trackAgentResponseReceived forwards counts", async () => {
    const { trackAgentResponseReceived } = await import("./events");
    trackAgentResponseReceived({
      action_count: 3,
      preference_count: 1,
      duration_ms: 1234,
    });
    expect(client.logEvent).toHaveBeenCalledWith("agent_response_received", {
      action_count: 3,
      preference_count: 1,
      duration_ms: 1234,
    });
  });

  it("trackSignInInitiated includes provider", async () => {
    const { trackSignInInitiated } = await import("./events");
    trackSignInInitiated("google");
    expect(client.logEvent).toHaveBeenCalledWith("signin_initiated", {
      provider: "google",
    });
  });

  it("trackScreenView forwards page_path and extra params", async () => {
    const { trackScreenView } = await import("./events");
    trackScreenView("/trips/abc", { trip_id: "abc" });
    expect(client.logEvent).toHaveBeenCalledWith("screen_view", {
      page_path: "/trips/abc",
      trip_id: "abc",
    });
  });

  it("trackNodeAction forwards action kind and source", async () => {
    const { trackNodeAction } = await import("./events");
    trackNodeAction({ action: "toggled", action_type: "todo", source: "ui" });
    expect(client.logEvent).toHaveBeenCalledWith("node_action", {
      action: "toggled",
      action_type: "todo",
      source: "ui",
    });
  });
});

describe("analytics factory", () => {
  beforeEach(() => {
    __resetAnalyticsClientForTests(null);
    vi.resetModules();
  });

  it("returns a no-op client when measurementId is missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", "");
    const { getAnalyticsClient } = await import("./client");
    const c = getAnalyticsClient();
    expect(c.isEnabled()).toBe(false);
    // All methods should be safe to call
    c.logEvent("anything", { x: 1 });
    c.setUserId("u_1");
    c.setUserProperties({ a: 1 });
    c.setEnabled(true);
    vi.unstubAllEnvs();
  });

  it("returns a no-op client on server (no window)", async () => {
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", "G-TEST");
    const originalWindow = globalThis.window;
    // @ts-expect-error — simulate SSR
    delete globalThis.window;
    const { getAnalyticsClient } = await import("./client");
    const c = getAnalyticsClient();
    expect(c.isEnabled()).toBe(false);
    globalThis.window = originalWindow;
    vi.unstubAllEnvs();
  });
});
