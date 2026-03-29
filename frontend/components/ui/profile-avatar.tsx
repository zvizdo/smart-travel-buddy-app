"use client";

import Link from "next/link";

interface ProfileAvatarProps {
  name?: string | null;
  size?: "sm" | "md";
}

function getInitials(name?: string | null): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export function ProfileAvatar({ name, size = "md" }: ProfileAvatarProps) {
  const initials = getInitials(name);
  const sizeClasses =
    size === "sm"
      ? "h-9 w-9 text-xs"
      : "h-10 w-10 text-sm";

  return (
    <Link
      href="/profile"
      className={`${sizeClasses} rounded-full bg-surface-low flex items-center justify-center font-semibold text-primary transition-colors active:bg-surface-container`}
      title="Profile"
    >
      {initials}
    </Link>
  );
}
