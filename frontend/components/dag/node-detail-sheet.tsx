"use client";

import { useRef, useState } from "react";
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
  onToggleAction?: (
    nodeId: string,
    actionId: string,
    isCompleted: boolean,
  ) => void | Promise<void>;
  plannerReadOnly?: boolean;
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
  onProposeChanges?: () => void;
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
  plannerReadOnly = false,
  onClose,
  onEdit,
  onDelete,
  onAddAction,
  onDeleteAction,
  onToggleAction,
  onBranch,
  onProposeChanges,
}: NodeDetailSheetProps) {
  const [mode, setMode] = useState<"view" | "edit" | "branch">("view");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionTab, setActionTab] = useState<ActionTab>("note");
  const [dragY, setDragY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ y: number; t: number } | null>(null);
  const lastMove = useRef<{ y: number; t: number } | null>(null);

  const canDrag = mode === "view";

  function handleDragPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!canDrag) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const now = performance.now();
    dragStart.current = { y: e.clientY, t: now };
    lastMove.current = { y: e.clientY, t: now };
    setIsDragging(true);
  }

  function handleDragPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!isDragging || !dragStart.current) return;
    const dy = Math.max(0, e.clientY - dragStart.current.y);
    setDragY(dy);
    lastMove.current = { y: e.clientY, t: performance.now() };
  }

  function handleDragPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!isDragging || !dragStart.current) {
      setIsDragging(false);
      return;
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    const height = sheetRef.current?.offsetHeight ?? 1;
    const dy = dragY;
    let velocity = 0;
    if (lastMove.current && dragStart.current) {
      const dt = lastMove.current.t - dragStart.current.t;
      if (dt > 0) {
        velocity = ((lastMove.current.y - dragStart.current.y) / dt) * 1000;
      }
    }
    setIsDragging(false);
    dragStart.current = null;
    lastMove.current = null;
    if (dy > height * 0.3 || velocity > 500) {
      onClose();
    } else {
      setDragY(0);
    }
  }

  function handleHandleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClose();
    }
  }

  const mapsUrl = node.place_id
    ? `https://www.google.com/maps/place/?q=place_id:${node.place_id}`
    : node.lat_lng
      ? `https://www.google.com/maps/@${node.lat_lng.lat},${node.lat_lng.lng},17z`
      : null;

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
    <div
      ref={sheetRef}
      className="absolute bottom-[var(--bottom-nav-height,0px)] left-0 right-0 z-10 rounded-t-3xl bg-surface-lowest shadow-float animate-slide-up max-h-[70vh] flex flex-col"
      style={{
        transform: dragY > 0 ? `translateY(${dragY}px)` : undefined,
        transition: isDragging ? "none" : "transform 0.25s ease-out",
      }}
    >
      {/* Handle — swipe down to close (view mode only) */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Drag down or press Enter to close"
        onPointerDown={handleDragPointerDown}
        onPointerMove={handleDragPointerMove}
        onPointerUp={handleDragPointerUp}
        onPointerCancel={handleDragPointerUp}
        onKeyDown={handleHandleKeyDown}
        className={`flex justify-center py-3 shrink-0 touch-none ${canDrag ? "cursor-grab active:cursor-grabbing" : "cursor-default"}`}
      >
        <div className="h-1 w-10 rounded-full bg-surface-high" />
      </div>

      <div className="flex items-start justify-between px-5 pt-2 pb-3 shrink-0">
        <div>
          <h2 className="text-lg font-bold text-on-surface">{node.name}</h2>
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium mt-1 ${TYPE_COLORS[node.type] || "bg-surface-high text-on-surface-variant"}`}
          >
            {TYPE_LABELS[node.type] || node.type}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {mode === "view" && plannerReadOnly && onProposeChanges && (
            <button
              onClick={onProposeChanges}
              className="rounded-full px-3 py-1.5 text-xs font-semibold text-on-surface-variant bg-surface-high border border-outline-variant transition-all active:scale-95"
            >
              Ask AI to edit
            </button>
          )}
          {mode === "view" && !plannerReadOnly && canEdit && onEdit && (
            <button
              onClick={() => setMode("edit")}
              className="rounded-full px-3 py-1.5 text-xs font-semibold text-primary bg-primary/10 transition-all active:scale-95"
            >
              Edit
            </button>
          )}
          {mode === "view" && !plannerReadOnly && canEdit && onBranch && (
            <button
              onClick={() => setMode("branch")}
              className="rounded-full px-3 py-1.5 text-xs font-semibold text-on-surface-variant bg-surface-high transition-all active:scale-95"
            >
              Side trip
            </button>
          )}
          {mode === "view" && !plannerReadOnly && canEdit && onDelete && (
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
            aria-label="Close panel"
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

      <div className="overflow-y-auto min-h-0">
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
            {mapsUrl && (
              <a
                href={mapsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-primary/80 hover:text-primary"
              >
                <svg
                  className="h-3 w-3"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
                  />
                </svg>
                Open in Maps
              </a>
            )}
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
    </div>
  );
}
