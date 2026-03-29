"use client";

import { AdvancedMarker } from "@vis.gl/react-google-maps";
import type { DocumentData } from "firebase/firestore";
import { formatUserName } from "@/lib/user-display";

interface PulseAvatarsProps {
  locations: DocumentData[];
  participants: Record<string, { role: string; display_name?: string }>;
  currentUserId: string;
}

const AVATAR_COLORS = [
  "bg-rose-500",
  "bg-sky-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-violet-500",
  "bg-teal-500",
  "bg-pink-500",
  "bg-cyan-500",
];

function getInitials(name?: string): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function getColorForUser(userId: string, allUserIds: string[]): string {
  const index = allUserIds.indexOf(userId);
  return AVATAR_COLORS[index % AVATAR_COLORS.length];
}

function formatTimeSince(updatedAt: string | { seconds: number }): string {
  let ms: number;
  if (typeof updatedAt === "string") {
    ms = Date.now() - new Date(updatedAt).getTime();
  } else if (updatedAt && typeof updatedAt === "object" && "seconds" in updatedAt) {
    ms = Date.now() - updatedAt.seconds * 1000;
  } else {
    return "";
  }
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function PulseAvatars({
  locations,
  participants,
  currentUserId,
}: PulseAvatarsProps) {
  const allUserIds = Object.keys(participants).sort();
  const otherLocations = locations.filter(
    (loc) => loc.user_id !== currentUserId,
  );

  if (otherLocations.length === 0) return null;

  return (
    <>
      {otherLocations.map((loc) => {
        const coords = loc.coords as { lat: number; lng: number } | undefined;
        if (!coords?.lat || !coords?.lng) return null;

        const participant = participants[loc.user_id];
        const displayName = formatUserName(participant?.display_name, loc.user_id);
        const initials = getInitials(displayName);
        const color = getColorForUser(loc.user_id, allUserIds);
        const timeSince = formatTimeSince(loc.updated_at);

        return (
          <AdvancedMarker
            key={loc.user_id}
            position={{ lat: coords.lat, lng: coords.lng }}
          >
            <div className="flex flex-col items-center">
              <div
                className={`flex h-8 w-8 items-center justify-center rounded-full ${color} text-xs font-bold text-white shadow-soft ring-2 ring-surface-lowest`}
                title={`${displayName} — ${timeSince}`}
              >
                {initials}
              </div>
              <div className="mt-0.5 rounded-full bg-inverse-surface/70 px-1.5 py-0.5 text-[9px] text-inverse-on-surface">
                {timeSince}
              </div>
            </div>
          </AdvancedMarker>
        );
      })}
    </>
  );
}
