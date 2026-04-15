"use client";

import { type ReactNode } from "react";
import { APIProvider } from "@vis.gl/react-google-maps";
import { AuthProvider } from "@/components/auth/auth-provider";
import { ToastProvider } from "@/components/ui/toast";
import { AnalyticsProvider } from "@/lib/analytics";

const MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || "";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <AnalyticsProvider>
        <APIProvider apiKey={MAPS_API_KEY}>{children}</APIProvider>
      </AnalyticsProvider>
      <ToastProvider />
    </AuthProvider>
  );
}
