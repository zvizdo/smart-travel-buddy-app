"use client";

import type { Analytics } from "firebase/analytics";

export interface AnalyticsClient {
  logEvent(name: string, params?: Record<string, unknown>): void;
  setUserId(userId: string | null): void;
  setUserProperties(props: Record<string, unknown>): void;
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
}

class NoopAnalyticsClient implements AnalyticsClient {
  logEvent(): void {}
  setUserId(): void {}
  setUserProperties(): void {}
  setEnabled(): void {}
  isEnabled(): boolean {
    return false;
  }
}

class FirebaseAnalyticsClient implements AnalyticsClient {
  private analytics: Analytics | null = null;
  private initPromise: Promise<Analytics | null> | null = null;
  private enabled = true;
  private pendingUserId: string | null | undefined = undefined;
  private pendingUserProps: Record<string, unknown> = {};

  constructor(private measurementId: string) {
    void this.init();
  }

  private async init(): Promise<Analytics | null> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      try {
        const [{ getAnalytics, isSupported, setAnalyticsCollectionEnabled }, { getFirebaseApp }] =
          await Promise.all([import("firebase/analytics"), import("@/lib/firebase")]);
        
        const supported = await isSupported();
        if (!supported) return null;
        
        const app = getFirebaseApp();
        const analytics = getAnalytics(app);
        this.analytics = analytics;
        setAnalyticsCollectionEnabled(analytics, this.enabled);
        
        if (this.pendingUserId !== undefined) {
          const { setUserId } = await import("firebase/analytics");
          setUserId(analytics, this.pendingUserId);
        }
        if (Object.keys(this.pendingUserProps).length > 0) {
          const { setUserProperties } = await import("firebase/analytics");
          setUserProperties(analytics, this.pendingUserProps);
        }
        return analytics;
      } catch (err) {
        console.error("Failed to initialize Firebase Analytics:", err);
        return null;
      }
    })();
    return this.initPromise;
  }

  logEvent(name: string, params?: Record<string, unknown>): void {
    void (async () => {
      const analytics = await this.init();
      if (!analytics || !this.enabled) return;
      const { logEvent } = await import("firebase/analytics");
      logEvent(analytics, name, sanitizeParams(params));
    })();
  }

  setUserId(userId: string | null): void {
    this.pendingUserId = userId;
    void (async () => {
      const analytics = await this.init();
      if (!analytics) return;
      const { setUserId } = await import("firebase/analytics");
      setUserId(analytics, userId);
    })();
  }

  setUserProperties(props: Record<string, unknown>): void {
    this.pendingUserProps = { ...this.pendingUserProps, ...props };
    void (async () => {
      const analytics = await this.init();
      if (!analytics) return;
      const { setUserProperties } = await import("firebase/analytics");
      setUserProperties(analytics, props);
    })();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    void (async () => {
      const analytics = await this.init();
      if (!analytics) return;
      const { setAnalyticsCollectionEnabled } = await import("firebase/analytics");
      setAnalyticsCollectionEnabled(analytics, enabled);
    })();
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

function sanitizeParams(
  params?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!params) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string") {
      out[key] = value.length > 100 ? value.slice(0, 100) : value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else {
      out[key] = String(value).slice(0, 100);
    }
  }
  return out;
}

let singleton: AnalyticsClient | null = null;

export function getAnalyticsClient(): AnalyticsClient {
  if (singleton) return singleton;
  
  const measurementId = process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID;
  const appId = process.env.NEXT_PUBLIC_FIREBASE_APP_ID;

  if (typeof window === "undefined" || !measurementId || !appId) {
    singleton = new NoopAnalyticsClient();
  } else {
    singleton = new FirebaseAnalyticsClient(measurementId);
  }
  
  return singleton;
}

export function __resetAnalyticsClientForTests(client: AnalyticsClient | null): void {
  singleton = client;
}
