"use client";

import { type ReactNode } from "react";
import { APIProvider } from "@vis.gl/react-google-maps";
import { AuthProvider } from "@/components/auth/auth-provider";

const MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || "";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <APIProvider apiKey={MAPS_API_KEY}>{children}</APIProvider>
    </AuthProvider>
  );
}
