"use client";

import { useState } from "react";
import { type DocumentData } from "firebase/firestore";
import { NodeEditForm } from "@/components/dag/node-edit-form";
import { BranchForm } from "@/components/dag/branch-form";
import { ActionList, type ActionTab } from "@/components/dag/action-list";
import { AddActionForm, type AddActionData } from "@/components/dag/add-action-form";
import {
  formatDateTimeWithPreference,
  type DateFormatPreference,
} from "@/lib/dates";

interface NodeDetailSheetProps {
  node: DocumentData;
  allNodes?: DocumentData[];
  userRole?: string;
  online?: boolean;
  datetimeFormat?: "12h" | "24h";
  dateFormat?: DateFormatPreference;
  actions?: DocumentData[];
  actionsLoading?: boolean;
  onClose: () => void;
  onEdit?: (nodeId: string, updates: Record<string, unknown>) => void;
  onDelete?: (nodeId: string) => void;
  onAddAction?: (nodeId: string, data: AddActionData) => void;
  onDeleteAction?: (nodeId: string, actionId: string) => void;
  onToggleAction?: (nodeId: string, actionId: string, isCompleted: boolean) => void;
  onBranch?: (
    nodeId: string,
    data: {
      name: string;
      type: string;
      lat: number;
      lng: number;
      place_id: string | null;
      arrival_time: string | null;
      departure_time: string | null;
      travel_mode: string;
      travel_time_hours: number;
      distance_km: number | null;
      route_polyline: string | null;
      connect_to_node_id: string | null;
    },
  ) => void;
}

const TYPE_LABELS: Record<string, string> = {
  city: "City",
  hotel: "Hotel",
  restaurant: "Restaurant",
  place: "Place",
  activity: "Activity",
};

const TYPE_COLORS: Record<string, string> = {
  city: "bg-primary/10 text-primary",
  hotel: "bg-[#7c4dff]/10 text-[#5e35b1]",
  restaurant: "bg-tertiary-container/30 text-on-tertiary-container",
  place: "bg-secondary/10 text-secondary",
  activity: "bg-error/10 text-error",
};

export function NodeDetailSheet({
  node,
  allNodes,
  userRole = "viewer",
  online = true,
  datetimeFormat = "24h",
  dateFormat = "eu",
  actions = [],
  actionsLoading,
  onClose,
  onEdit,
  onDelete,
  onAddAction,
  onDeleteAction,
  onToggleAction,
  onBranch,
}: NodeDetailSheetProps) {
  const [mode, setMode] = useState<"view" | "edit" | "branch">("view");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionTab, setActionTab] = useState<ActionTab>("note");

  const tz = node.timezone ?? undefined;
  const arrivalDate = node.arrival_time
    ? formatDateTimeWithPreference(
        node.arrival_time,
        datetimeFormat,
        dateFormat,
        tz,
      )
    : null;
  const departureDate = node.departure_time
    ? formatDateTimeWithPreference(
        node.departure_time,
        datetimeFormat,
        dateFormat,
        tz,
      )
    : null;

  function handleSave(updates: Record<string, unknown>) {
    onEdit?.(node.id, updates);
    setMode("view");
  }

  function handleBranch(data: Parameters<NonNullable<typeof onBranch>>[1]) {
    onBranch?.(node.id, data);
    setMode("view");
  }

  function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    onDelete?.(node.id);
  }

  const canEdit = online && (userRole === "admin" || userRole === "planner");

  return (
    <div className="absolute bottom-[var(--bottom-nav-height,0px)] left-0 right-0 z-10 rounded-t-3xl bg-surface-lowest shadow-float animate-slide-up">
      {/* Handle */}
      <div className="flex justify-center pt-3 pb-1">
        <div className="h-1 w-10 rounded-full bg-surface-high" />
      </div>

      <div className="flex items-start justify-between px-5 pt-2 pb-3">
        <div>
          <h2 className="text-lg font-bold text-on-surface">{node.name}</h2>
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium mt-1 ${TYPE_COLORS[node.type] || "bg-surface-high text-on-surface-variant"}`}
          >
            {TYPE_LABELS[node.type] || node.type}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {mode === "view" && canEdit && onEdit && (
            <button
              onClick={() => setMode("edit")}
              className="rounded-full px-3 py-1.5 text-xs font-semibold text-primary bg-primary/10 transition-all active:scale-95"
            >
              Edit
            </button>
          )}
          {mode === "view" && canEdit && onBranch && (
            <button
              onClick={() => setMode("branch")}
              className="rounded-full px-3 py-1.5 text-xs font-semibold text-on-surface-variant bg-surface-high transition-all active:scale-95"
            >
              Branch
            </button>
          )}
          {mode === "view" && canEdit && onDelete && (
            <button
              onClick={handleDelete}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-all active:scale-95 ${
                confirmDelete
                  ? "bg-error text-on-error"
                  : "text-error bg-error/10"
              }`}
            >
              {confirmDelete ? "Confirm?" : "Delete"}
            </button>
          )}
          <button
            onClick={onClose}
            className="h-8 w-8 rounded-full bg-surface-low flex items-center justify-center text-on-surface-variant transition-colors active:bg-surface-container ml-1"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18 18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      </div>

      {mode === "edit" ? (
        <NodeEditForm
          node={node as Parameters<typeof NodeEditForm>[0]["node"]}
          userRole={userRole}
          datetimeFormat={datetimeFormat}
          dateFormat={dateFormat}
          onSave={handleSave}
          onCancel={() => setMode("view")}
        />
      ) : mode === "branch" ? (
        <BranchForm
          sourceNode={node}
          allNodes={allNodes ?? []}
          onSubmit={handleBranch}
          datetimeFormat={datetimeFormat}
          dateFormat={dateFormat}
          onCancel={() => setMode("view")}
        />
      ) : (
        <div className="px-5 pb-5 space-y-3">
          {arrivalDate && (
            <div className="flex justify-between text-sm">
              <span className="text-on-surface-variant">Arrival</span>
              <span className="font-medium text-on-surface">{arrivalDate}</span>
            </div>
          )}
          {departureDate && (
            <div className="flex justify-between text-sm">
              <span className="text-on-surface-variant">Departure</span>
              <span className="font-medium text-on-surface">
                {departureDate}
              </span>
            </div>
          )}
          {node.arrival_time &&
            node.departure_time &&
            (() => {
              const hours =
                (new Date(node.departure_time).getTime() -
                  new Date(node.arrival_time).getTime()) /
                3_600_000;
              if (hours <= 0) return null;
              return (
                <div className="flex justify-between text-sm">
                  <span className="text-on-surface-variant">Duration</span>
                  <span className="font-medium text-on-surface">
                    {hours >= 24
                      ? `${Math.round(hours / 24)} days`
                      : `${Math.round(hours * 10) / 10}h`}
                  </span>
                </div>
              );
            })()}
          <ActionList
            actions={actions}
            loading={actionsLoading}
            onTabChange={setActionTab}
            onToggle={
              onToggleAction
                ? (actionId, isCompleted) =>
                    onToggleAction(node.id, actionId, isCompleted)
                : undefined
            }
            onDelete={
              onDeleteAction
                ? (actionId) => onDeleteAction(node.id, actionId)
                : undefined
            }
          />
          {online && (
            <AddActionForm
              onSubmit={(data) => onAddAction?.(node.id, data)}
              disabled={!onAddAction}
              defaultTab={actionTab}
              locationBias={
                node.lat_lng
                  ? { lat: node.lat_lng.lat, lng: node.lat_lng.lng }
                  : undefined
              }
            />
          )}
        </div>
      )}
    </div>
  );
}
