"use client";

import { formatDateTimeWithPreference, type DateFormatPreference } from "@/lib/dates";

interface AffectedNode {
  id: string;
  name: string;
  old_arrival: string | null;
  new_arrival: string;
  old_departure: string | null;
  new_departure: string;
}

interface CascadePreviewData {
  affected_nodes: AffectedNode[];
  conflicts: { id: string; message: string }[];
}

interface CascadePreviewProps {
  preview: CascadePreviewData;
  nodeTimezones?: Record<string, string>;
  datetimeFormat?: "12h" | "24h";
  dateFormat?: DateFormatPreference;
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function CascadePreview({
  preview,
  nodeTimezones,
  datetimeFormat = "24h",
  dateFormat = "eu",
  loading,
  onConfirm,
  onCancel,
}: CascadePreviewProps) {
  const { affected_nodes, conflicts } = preview;

  if (affected_nodes.length === 0) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-inverse-surface/40">
      <div className="w-full max-w-lg bg-surface-lowest rounded-t-3xl sm:rounded-3xl shadow-float max-h-[80vh] flex flex-col animate-slide-up">
        <div className="px-5 pt-5 pb-3">
          <h2 className="text-lg font-bold text-on-surface">
            Update following stops?
          </h2>
          <p className="text-xs text-on-surface-variant mt-1">
            Your change was saved. {affected_nodes.length === 1
              ? "This stop may need a new arrival time."
              : `These ${affected_nodes.length} stops may need new arrival times.`}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
          {conflicts.length > 0 && (
            <div className="rounded-2xl bg-error/10 p-4 mb-2">
              <p className="text-sm font-semibold text-error">
                Some stops have scheduling conflicts
              </p>
              {conflicts.map((c) => (
                <p key={c.id} className="text-xs text-error/80 mt-1">
                  {c.message}
                </p>
              ))}
            </div>
          )}

          {affected_nodes.map((node) => {
            const tz = nodeTimezones?.[node.id];
            return (
              <div
                key={node.id}
                className="rounded-2xl bg-surface-low p-4"
              >
                <p className="text-sm font-semibold text-on-surface">
                  {node.name}
                </p>
                <div className="mt-2 grid grid-cols-2 gap-x-4 text-xs">
                  <div>
                    <span className="text-on-surface-variant">Before: </span>
                    <span className="text-outline line-through">
                      {formatDateTimeWithPreference(node.old_arrival, datetimeFormat, dateFormat, tz)}
                    </span>
                  </div>
                  <div>
                    <span className="text-on-surface-variant">After: </span>
                    <span className="text-secondary font-medium">
                      {formatDateTimeWithPreference(node.new_arrival, datetimeFormat, dateFormat, tz)}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="px-5 pt-3 pb-1">
          <p className="text-xs text-on-surface-variant text-center">
            Your edit is already saved — this just updates the times for stops after it.
          </p>
        </div>
        <div className="flex gap-3 p-5 pt-3">
          <button
            onClick={onCancel}
            disabled={loading}
            className="flex-1 rounded-2xl bg-surface-high py-3 text-sm font-semibold text-on-surface transition-all active:scale-[0.98] disabled:opacity-40"
          >
            Skip for now
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="flex-1 rounded-2xl gradient-primary py-3 text-sm font-semibold text-on-primary shadow-soft transition-all active:scale-[0.98] disabled:opacity-40"
          >
            {loading ? "Applying..." : "Update all"}
          </button>
        </div>
      </div>
    </div>
  );
}
