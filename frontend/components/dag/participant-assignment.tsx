"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { formatUserName } from "@/lib/user-display";

interface ParticipantAssignmentProps {
  tripId: string;
  planId: string;
  nodeId: string;
  nodeName: string;
  participants: Record<string, { role: string; display_name?: string }>;
  currentParticipantIds: string[] | null;
  onClose: () => void;
  onSaved: () => void;
}

export function ParticipantAssignment({
  tripId,
  planId,
  nodeId,
  nodeName,
  participants,
  currentParticipantIds,
  onClose,
  onSaved,
}: ParticipantAssignmentProps) {
  const [selected, setSelected] = useState<Set<string>>(
    new Set(currentParticipantIds ?? []),
  );
  const [saving, setSaving] = useState(false);

  function toggle(uid: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) {
        next.delete(uid);
      } else {
        next.add(uid);
      }
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      await api.patch(
        `/trips/${tripId}/plans/${planId}/nodes/${nodeId}/participants`,
        { participant_ids: Array.from(selected) },
      );
      onSaved();
    } catch {
      // Error handled by api client
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-inverse-surface/40">
      <div className="w-full max-w-md bg-surface-lowest rounded-t-3xl sm:rounded-3xl shadow-float">
        <div className="flex justify-center pt-3 pb-1 sm:hidden"><div className="h-1 w-10 rounded-full bg-surface-high" /></div>
        <div className="px-4 pt-3 pb-2">
          <h2 className="text-base font-semibold text-on-surface">Assign Participants</h2>
          <p className="text-xs text-on-surface-variant mt-0.5">
            Select who travels through {nodeName}
          </p>
        </div>

        <div className="p-4 space-y-2">
          {Object.entries(participants).map(([uid, p]) => (
            <label
              key={uid}
              className="flex items-center gap-3 rounded-xl bg-surface-low px-3 py-2.5 cursor-pointer hover:bg-surface-high transition-colors"
            >
              <input
                type="checkbox"
                checked={selected.has(uid)}
                onChange={() => toggle(uid)}
                className="rounded"
              />
              <span className="text-sm flex-1 truncate text-on-surface">{formatUserName(p.display_name, uid)}</span>
              <span className="text-xs text-on-surface-variant capitalize">
                {p.role}
              </span>
            </label>
          ))}
        </div>

        <div className="flex gap-2 p-4">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 rounded-xl gradient-primary px-4 py-2.5 text-sm font-semibold text-on-primary shadow-soft transition-all active:scale-[0.98] disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            onClick={onClose}
            disabled={saving}
            className="flex-1 rounded-xl bg-surface-high px-4 py-2.5 text-sm font-semibold text-on-surface-variant disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
