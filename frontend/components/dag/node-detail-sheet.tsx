"use client";

import { useRef, useState, useMemo } from "react";
import { type DocumentData } from "firebase/firestore";
import { NodeEditForm } from "@/components/dag/node-edit-form";
import { CreateNodeForm } from "@/components/dag/create-node-form";
import { ActionList, type ActionTab } from "@/components/dag/action-list";
import { AddActionForm, type AddActionData } from "@/components/dag/add-action-form";
import {
  formatDateTimeWithPreference,
  type DateFormatPreference,
} from "@/lib/dates";
import {
  isRestNode,
  type RawEdge,
  type RawNode,
  type TripSettingsLike,
} from "@/lib/time-inference";

interface NodeDetailSheetProps {
  node: DocumentData;
  allNodes?: DocumentData[];
  allEdges?: RawEdge[];
  tripSettings?: TripSettingsLike | null;
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
      duration_minutes: number | null;
      travel_mode: string;
      travel_time_hours: number;
      distance_km: number | null;
      route_polyline: string | null;
      connect_to_node_id: string | null;
    },
  ) => void;
  onProposeChanges?: () => void;
  onShiftFollowing?: (
    shifts: Array<{
      id: string;
      arrival_time: string | null;
      departure_time: string | null;
    }>,
  ) => void | Promise<void>;
  onImpactDiscarded?: () => void;
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

type TimingConflictSeverity = "info" | "advisory" | "error";

function parseTimingDelta(raw: string): { delta: string; direction: "early" | "late" } | null {
  const match = raw.match(/\bis (\S+) (early|late)\b/);
  if (!match) return null;
  return { delta: match[1], direction: match[2] as "early" | "late" };
}

function timingConflictCopy(raw: string, severity: TimingConflictSeverity): { title: string; detail: string } {
  const parsed = parseTimingDelta(raw);
  if (!parsed) return { title: "Timing conflict", detail: raw };
  const { delta, direction } = parsed;
  if (direction === "early") {
    if (severity === "advisory") {
      return {
        title: "Large buffer before this stop",
        detail: `You'll arrive ${delta} early. Consider adding a stop or adjusting your departure.`,
      };
    }
    return {
      title: "Arriving early",
      detail: `You'll arrive about ${delta} before your scheduled time.`,
    };
  }
  return {
    title: "Running late",
    detail: `You'll arrive ${delta} after your scheduled time. Leave earlier, reschedule, or remove the fixed time.`,
  };
}

const SEVERITY_TREATMENTS: Record<TimingConflictSeverity, { bg: string; color: string; icon: "warn" | "info" }> = {
  error: { bg: "bg-error/10", color: "text-error", icon: "warn" },
  advisory: { bg: "bg-[#fef3c7]", color: "text-[#92400e]", icon: "warn" },
  info: { bg: "bg-surface-high", color: "text-on-surface-variant", icon: "info" },
};

export function NodeDetailSheet({
  node,
  allNodes,
  allEdges,
  tripSettings,
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
  onShiftFollowing,
  onImpactDiscarded,
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

  const driveSegments = useMemo(() => {
    if (!node.drive_cap_warning || !allNodes || !allEdges) return null;
    
    interface Path {
      segments: Array<{ fromName: string; toName: string; hours: number }>;
      totalHours: number;
    }
    
    function getPathsBackwards(currentId: string, visited: Set<string> = new Set()): Path[] {
      if (visited.has(currentId)) return [{ segments: [], totalHours: 0 }];
      visited.add(currentId);
      
      const incomingEdges = allEdges!.filter(
        (e) => e.to_node_id === currentId && (e.travel_mode === "drive" || e.travel_mode === "walk" || !e.travel_mode)
      );
      
      if (incomingEdges.length === 0) {
        visited.delete(currentId);
        return [{ segments: [], totalHours: 0 }];
      }
      
      const currentName = allNodes!.find((n) => n.id === currentId)?.name || currentId;
      const resultPaths: Path[] = [];
      
      for (const edge of incomingEdges) {
        const parentNode = allNodes!.find((n) => n.id === edge.from_node_id);
        if (!parentNode) continue;
        
        const segment = {
          fromName: parentNode.name,
          toName: currentName,
          hours: edge.travel_time_hours || 0,
        };
        
        if (isRestNode(parentNode as any)) {
           resultPaths.push({ segments: [segment], totalHours: segment.hours });
        } else {
           const subPaths = getPathsBackwards(parentNode.id, visited);
           for (const sp of subPaths) {
             resultPaths.push({
               segments: [...sp.segments, segment],
               totalHours: sp.totalHours + segment.hours
             });
           }
        }
      }
      
      visited.delete(currentId);
      
      if (resultPaths.length === 0) return [{ segments: [], totalHours: 0 }];
      return resultPaths;
    }
    
    const paths = getPathsBackwards(node.id);
    if (paths.length === 0) return null;
    
    let maxPath = paths[0];
    for (const p of paths) {
      if (p.totalHours > maxPath.totalHours) maxPath = p;
    }
    
    return maxPath;
  }, [node.drive_cap_warning, node.id, allNodes, allEdges]);

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
            allNodes={allNodes as RawNode[] | undefined}
            allEdges={allEdges}
            tripSettings={tripSettings}
            onSave={handleSave}
            onCancel={() => setMode("view")}
            onShiftFollowing={onShiftFollowing}
            onImpactDiscarded={onImpactDiscarded}
          />
        ) : mode === "branch" ? (
          <CreateNodeForm
            context={{ type: "branch", sourceNode: node }}
            allNodes={allNodes ?? []}
            datetimeFormat={datetimeFormat}
            dateFormat={dateFormat}
            onSubmit={() => {}}
            onSubmitBranch={handleBranch}
            onCancel={() => setMode("view")}
          />
        ) : (
          <div className="px-5 pb-5 space-y-3">
            {!node.is_start && arrivalDate && (
              <div className="flex justify-between text-sm">
                <span className="text-on-surface-variant">Arrival</span>
                <span className={node.arrival_time_estimated ? "italic text-on-surface-variant" : "font-medium text-on-surface"}>
                  {node.arrival_time_estimated ? `~${arrivalDate}` : arrivalDate}
                </span>
              </div>
            )}
            {!node.is_end && departureDate && (
              <div className="flex justify-between text-sm">
                <span className="text-on-surface-variant">
                  {!node.departure_time_estimated && node.arrival_time_estimated ? "Leaves" : "Departure"}
                </span>
                <span className={node.departure_time_estimated ? "italic text-on-surface-variant" : "font-medium text-on-surface"}>
                  {node.departure_time_estimated ? `~${departureDate}` : departureDate}
                </span>
              </div>
            )}
            {node.timing_conflict && (() => {
              const severity: TimingConflictSeverity = (node.timing_conflict_severity as TimingConflictSeverity | null) ?? "error";
              const treatment = SEVERITY_TREATMENTS[severity];
              const { title, detail } = timingConflictCopy(String(node.timing_conflict), severity);
              return (
                <div className={`rounded-xl ${treatment.bg} px-4 py-3 flex items-start gap-2`}>
                  {treatment.icon === "info" ? (
                    <svg className={`h-4 w-4 shrink-0 mt-0.5 ${treatment.color}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="16" x2="12" y2="12" strokeLinecap="round" />
                      <line x1="12" y1="8" x2="12.01" y2="8" strokeLinecap="round" />
                    </svg>
                  ) : (
                    <svg className={`h-4 w-4 shrink-0 mt-0.5 ${treatment.color}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                    </svg>
                  )}
                  <div>
                    <p className={`text-xs font-semibold leading-snug ${treatment.color}`}>{title}</p>
                    <p className="text-xs text-on-surface-variant mt-0.5 leading-snug">{detail}</p>
                  </div>
                </div>
              );
            })()}
            {node.drive_cap_warning && (
              <div className="rounded-xl bg-[#fef3c7] px-4 py-3 flex items-start gap-2">
                <svg className="h-4 w-4 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="#92400e">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                </svg>
                <div className="w-full">
                  <p className="text-xs font-semibold leading-snug" style={{ color: "#92400e" }}>
                    {node.hold_reason === "night_drive" ? "Night drive warning" : "Daily drive limit reached"}
                  </p>
                  <p className="text-xs mt-0.5 leading-snug" style={{ color: "#92400e" }}>
                    {node.hold_reason === "night_drive" 
                      ? "This route involves driving during your set overnight rest window. Consider adjusting your times." 
                      : "Drive cap exceeded before this stop — consider adding a rest stop earlier."}
                  </p>
                  {driveSegments && driveSegments.segments.length > 0 && (
                    <div className="mt-2 text-xs space-y-1">
                      <div className="font-medium mb-1" style={{ color: "#92400e" }}>Total Drive: {driveSegments.totalHours.toFixed(1)}h</div>
                      {driveSegments.segments.map((seg, idx) => (
                        <div key={idx} className="flex justify-between items-start opacity-80" style={{ color: "#92400e" }}>
                          <span className="truncate pr-2">
                            {seg.fromName} → {seg.toName}
                          </span>
                          <span className="whitespace-nowrap font-medium">{seg.hours.toFixed(1)}h</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
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
