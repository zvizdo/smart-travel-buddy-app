"use client";

import { useCallback, useState } from "react";
import { api } from "@/lib/api";
import { useOnlineStatus } from "@/components/ui/offline-banner";
import { enqueuePulse } from "@/lib/offline-queue";

interface PulseButtonProps {
  tripId: string;
  onToast?: (message: string) => void;
}

export function PulseButton({ tripId, onToast }: PulseButtonProps) {
  const [status, setStatus] = useState<
    "idle" | "locating" | "sending" | "done" | "error"
  >("idle");
  const online = useOnlineStatus();

  const handlePulse = useCallback(async () => {
    setStatus("locating");

    if (!navigator.geolocation) {
      onToast?.("GPS not available on this device");
      setStatus("error");
      setTimeout(() => setStatus("idle"), 3000);
      return;
    }

    try {
      const position = await new Promise<GeolocationPosition>(
        (resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 30000,
          });
        },
      );

      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      const heading = position.coords.heading ?? 0;

      if (!online) {
        enqueuePulse({ tripId, lat, lng, heading, timestamp: Date.now() });
        onToast?.("Location queued — will send when back online");
        setStatus("done");
        setTimeout(() => setStatus("idle"), 2000);
        return;
      }

      setStatus("sending");
      await api.post(`/trips/${tripId}/pulse`, { lat, lng, heading });
      onToast?.("Sharing your location with the group");
      setStatus("done");
      setTimeout(() => setStatus("idle"), 2000);
    } catch (err) {
      if (err instanceof GeolocationPositionError) {
        const messages: Record<number, string> = {
          1: "Location permission denied",
          2: "Position unavailable",
          3: "Location request timed out",
        };
        onToast?.(messages[err.code] ?? "Could not get location");
      } else {
        onToast?.("Failed to send check-in");
      }
      setStatus("error");
      setTimeout(() => setStatus("idle"), 3000);
    }
  }, [tripId, online, onToast]);

  const isActive = status === "locating" || status === "sending";

  return (
    <button
      onClick={handlePulse}
      disabled={isActive}
      className={`h-8 w-8 rounded-full flex items-center justify-center transition-all active:scale-90 ${
        status === "done"
          ? "bg-secondary text-on-secondary"
          : status === "error"
            ? "bg-error text-on-error"
            : "bg-primary/15 text-primary"
      } disabled:opacity-60`}
      title="Share your location"
    >
      {isActive ? (
        <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current/30 border-t-current" />
      ) : (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-4 w-4"
        >
          <path
            fillRule="evenodd"
            d="m9.69 18.933.003.001C9.89 19.02 10 19 10 19s.11.02.308-.066l.002-.001.006-.003.018-.008a5.741 5.741 0 0 0 .281-.14c.186-.096.446-.24.757-.433.62-.384 1.445-.966 2.274-1.765C15.302 14.988 17 12.493 17 9A7 7 0 1 0 3 9c0 3.492 1.698 5.988 3.355 7.584a13.731 13.731 0 0 0 2.274 1.765 11.842 11.842 0 0 0 .757.433c.113.058.2.1.257.128l.018.008.006.003ZM10 11.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5Z"
            clipRule="evenodd"
          />
        </svg>
      )}
    </button>
  );
}
