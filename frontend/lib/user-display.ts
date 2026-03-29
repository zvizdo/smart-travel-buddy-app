/**
 * Format a display name as "FirstName L." (first name + last initial).
 * Falls back to truncated ID if no name available.
 */
export function formatUserName(
  displayName?: string | null,
  userId?: string,
): string {
  if (displayName && displayName !== userId) {
    const parts = displayName.trim().split(/\s+/);
    if (parts.length >= 2) {
      return `${parts[0]} ${parts[1][0]}.`;
    }
    return parts[0];
  }
  if (userId) {
    return userId.slice(0, 8) + "...";
  }
  return "Unknown";
}

/**
 * Get initials from a display name.
 */
export function getInitials(name?: string | null): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}
