"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { formatNotificationDate } from "@/lib/dates";

interface NotificationItem {
  id: string;
  type: string;
  message: string;
  is_read: boolean;
  created_at: string;
}

interface NotificationBellProps {
  tripId: string;
}

export function NotificationBell({ tripId }: NotificationBellProps) {
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api
      .get<{ notifications: NotificationItem[] }>(
        `/trips/${tripId}/notifications`,
      )
      .then((res) => setNotifications(res.notifications))
      .catch(() => {});
  }, [tripId]);

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  async function handleMarkRead(notifId: string) {
    await api
      .patch(`/trips/${tripId}/notifications/${notifId}`, { is_read: true })
      .catch(() => {});
    setNotifications((prev) =>
      prev.map((n) => (n.id === notifId ? { ...n, is_read: true } : n)),
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="relative h-9 w-9 rounded-full bg-surface-lowest/80 flex items-center justify-center text-on-surface-variant shadow-soft transition-all active:scale-95"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4.5 w-4.5 items-center justify-center rounded-full bg-error text-[10px] font-bold text-on-error">
            {unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-72 rounded-2xl bg-surface-lowest shadow-float z-50 max-h-80 overflow-y-auto animate-fade-in">
          {notifications.length === 0 ? (
            <p className="p-5 text-xs text-on-surface-variant text-center">
              No notifications
            </p>
          ) : (
            notifications.map((n) => (
              <button
                key={n.id}
                onClick={() => handleMarkRead(n.id)}
                className={`w-full text-left px-4 py-3 transition-colors hover:bg-surface-low ${
                  !n.is_read ? "bg-primary/5" : ""
                }`}
              >
                <p className="text-xs text-on-surface leading-relaxed">
                  {n.message}
                </p>
                <p className="text-[10px] text-outline mt-1">
                  {formatNotificationDate(n.created_at)}
                </p>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
