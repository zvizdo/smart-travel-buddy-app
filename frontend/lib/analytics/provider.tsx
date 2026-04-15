"use client";

import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { api } from "@/lib/api";
import { getAnalyticsClient } from "./client";
import { useRouteTracking } from "./use-route-tracking";

interface AnalyticsContextValue {
  track: (name: string, params?: Record<string, unknown>) => void;
  setUserProperty: (key: string, value: unknown) => void;
}

const AnalyticsContext = createContext<AnalyticsContextValue | null>(null);

export function useAnalytics(): AnalyticsContextValue {
  const ctx = useContext(AnalyticsContext);
  if (!ctx) {
    throw new Error("useAnalytics must be used within AnalyticsProvider");
  }
  return ctx;
}

export function AnalyticsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const lastUserIdRef = useRef<string | null>(null);
  const lastPrefsUidRef = useRef<string | null>(null);

  useEffect(() => {
    const client = getAnalyticsClient();
    const currentUid = user?.uid ?? null;
    if (currentUid !== lastUserIdRef.current) {
      client.setUserId(currentUid);
      lastUserIdRef.current = currentUid;
    }
  }, [user]);

  useEffect(() => {
    if (!user || lastPrefsUidRef.current === user.uid) return;
    lastPrefsUidRef.current = user.uid;
    const controller = new AbortController();
    api
      .get<{ analytics_enabled?: boolean }>("/users/me", controller.signal)
      .then((profile) => {
        const enabled = profile.analytics_enabled ?? true;
        const client = getAnalyticsClient();
        client.setEnabled(enabled);
        client.setUserProperties({ analytics_enabled: enabled });
      })
      .catch(() => {
        // ignore — defaults to enabled
      });
    return () => controller.abort();
  }, [user]);

  const track = useCallback((name: string, params?: Record<string, unknown>) => {
    getAnalyticsClient().logEvent(name, params);
  }, []);

  const setUserProperty = useCallback((key: string, value: unknown) => {
    getAnalyticsClient().setUserProperties({ [key]: value });
  }, []);

  const value: AnalyticsContextValue = { track, setUserProperty };

  return (
    <AnalyticsContext.Provider value={value}>
      <RouteTracker />
      {children}
    </AnalyticsContext.Provider>
  );
}

function RouteTracker() {
  useRouteTracking();
  return null;
}
