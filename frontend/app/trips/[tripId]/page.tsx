"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useTripContext } from "@/app/trips/[tripId]/layout";
import { useAuth } from "@/components/auth/auth-provider";
import { api } from "@/lib/api";
import { useTripNodes, useTripEdges, usePulseLocations, useNodeActions } from "@/lib/firestore-hooks";
import { TripMap } from "@/components/map/trip-map";
import { NodeDetailSheet } from "@/components/dag/node-detail-sheet";
import { EdgeDetail } from "@/components/dag/edge-detail";
import { CascadePreview } from "@/components/dag/cascade-preview";
import { NotificationBell } from "@/components/ui/notification-bell";
import { PathFilter } from "@/components/map/path-filter";
import { AddNodeSheet } from "@/components/dag/add-node-sheet";
import { type PlaceResult } from "@/components/map/places-autocomplete";
import { DivergenceResolver } from "@/components/dag/divergence-resolver";
import {
  computeParticipantPaths,
  computeEdgeColors,
} from "@/lib/path-computation";
import { PlanSwitcher } from "@/components/dag/plan-switcher";
import { OfflineBanner, useOnlineStatus } from "@/components/ui/offline-banner";
import { flushQueue } from "@/lib/offline-queue";
import { BottomNav } from "@/components/ui/bottom-nav";
import { Toast } from "@/components/ui/toast";
import { ProfileAvatar } from "@/components/ui/profile-avatar";
import { AgentOverlay } from "@/components/chat/agent-overlay";

interface NodeData {
  id: string;
  name: string;
  type: string;
  lat_lng: { lat: number; lng: number } | null;
  arrival_time: string | null;
  departure_time: string | null;
  order_index: number;
  participant_ids?: string[] | null;
  [key: string]: unknown;
}

interface EdgeData {
  id: string;
  from_node_id: string;
  to_node_id: string;
  travel_mode: string;
  travel_time_hours: number;
  distance_km: number | null;
  [key: string]: unknown;
}

interface CascadePreviewData {
  affected_nodes: {
    id: string;
    name: string;
    old_arrival: string | null;
    new_arrival: string;
    old_departure: string | null;
    new_departure: string;
  }[];
  conflicts: { id: string; message: string }[];
}

export default function TripMapPage() {
  const { tripId, trip, mapFitted, markMapFitted, mapCamera, setMapCamera, viewedPlanId, setViewedPlanId } = useTripContext();
  const { user } = useAuth();
  const activePlanId = trip?.active_plan_id ?? null;

  const displayPlanId = viewedPlanId ?? activePlanId;

  const prevActivePlanRef = useRef(activePlanId);
  if (activePlanId !== prevActivePlanRef.current) {
    prevActivePlanRef.current = activePlanId;
    if (viewedPlanId && viewedPlanId !== activePlanId) {
      setViewedPlanId(null);
    }
  }

  const { data: liveNodes, loading: nodesLoading } = useTripNodes(
    tripId,
    displayPlanId,
  );
  const { data: liveEdges, loading: edgesLoading } = useTripEdges(
    tripId,
    displayPlanId,
  );

  const { data: rawLocations } = usePulseLocations(tripId);

  // Only surface locations for users who explicitly allow location sharing.
  // Prevents a flash of avatars before enrichment data arrives.
  const liveLocations = useMemo(() => {
    if (!trip?.participants) return [];
    return rawLocations.filter(
      (loc) => trip.participants[loc.user_id]?.location_tracking_enabled === true,
    );
  }, [rawLocations, trip?.participants]);
  const online = useOnlineStatus();

  useEffect(() => {
    if (online) {
      flushQueue(async (tid, lat, lng, heading) => {
        await api.post(`/trips/${tid}/pulse`, { lat, lng, heading });
      });
    }
  }, [online]);

  const nodes = liveNodes as NodeData[];
  const edges = liveEdges as EdgeData[];
  const loading = nodesLoading || edgesLoading;

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  const { data: nodeActions, loading: actionsLoading } = useNodeActions(
    tripId,
    displayPlanId,
    selectedNodeId,
  );

  const [cascadePreview, setCascadePreview] =
    useState<CascadePreviewData | null>(null);
  const [cascadeNodeId, setCascadeNodeId] = useState<string | null>(null);
  const [cascadeLoading, setCascadeLoading] = useState(false);

  const [pathMode, setPathMode] = useState<"all" | "mine">("all");

  const [addNodePlace, setAddNodePlace] = useState<PlaceResult | null>(null);

  const [activeTab, setActiveTab] = useState<"map" | "agent" | "settings">("map");
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const handleToastDismiss = useCallback(() => setToastMessage(null), []);

  function handleTabChange(tab: "map" | "agent" | "settings") {
    if (tab === "agent") {
      setActiveTab((prev) => (prev === "agent" ? "map" : "agent"));
    } else {
      setActiveTab(tab);
    }
  }

  const userRole = useMemo(() => {
    if (!user || !trip?.participants) return "viewer";
    const participant = trip.participants[user.uid];
    return participant?.role ?? "viewer";
  }, [user, trip]);

  const canEdit = online && (userRole === "admin" || userRole === "planner");

  const tripSettings = trip?.settings ?? {};
  const datetimeFormat = (tripSettings.datetime_format ?? "24h") as "12h" | "24h";
  const dateFormat = (tripSettings.date_format ?? "eu") as "us" | "eu" | "iso" | "short";
  const distanceUnit = (tripSettings.distance_unit ?? "km") as "km" | "mi";

  const selectedNode = useMemo(
    () => (selectedNodeId ? nodes.find((n) => n.id === selectedNodeId) : null),
    [nodes, selectedNodeId],
  );

  const selectedEdge = useMemo(
    () => (selectedEdgeId ? edges.find((e) => e.id === selectedEdgeId) : null),
    [edges, selectedEdgeId],
  );

  // Compute timing warning for the selected edge
  const selectedEdgeWarning = useMemo(() => {
    if (!selectedEdge) return { hasWarning: false, message: "" };
    const from = nodes.find((n) => n.id === selectedEdge.from_node_id);
    const to = nodes.find((n) => n.id === selectedEdge.to_node_id);
    const depTime = from?.departure_time ?? from?.arrival_time;
    const arrTime = to?.arrival_time;
    if (depTime && arrTime && selectedEdge.travel_time_hours > 0) {
      const depMs = new Date(depTime).getTime();
      const arrMs = new Date(arrTime).getTime();
      const travelMs = selectedEdge.travel_time_hours * 3_600_000;
      const deficitMin = Math.round((depMs + travelMs - arrMs) / 60_000);
      if (deficitMin > 10) {
        const deficitStr =
          deficitMin >= 60
            ? `${Math.round(deficitMin / 6) / 10}h`
            : `${deficitMin} min`;
        return {
          hasWarning: true,
          message: `Arrival at ${to?.name || "destination"} is ${deficitStr} earlier than the estimated travel time allows`,
        };
      }
    }
    return { hasWarning: false, message: "" };
  }, [selectedEdge, nodes]);

  const nodeMap = useMemo(() => {
    const m = new Map<string, NodeData>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);

  const participantIds = useMemo(
    () => (trip?.participants ? Object.keys(trip.participants) : []),
    [trip],
  );

  const pathResult = useMemo(() => {
    if (nodes.length === 0 || edges.length === 0) return null;
    return computeParticipantPaths(nodes, edges, participantIds);
  }, [nodes, edges, participantIds]);

  const edgeColors = useMemo(() => {
    if (!pathResult) return new Map<string, string>();
    // Only color edges when viewing "my path" — my edges get a distinct color,
    // everything else stays neutral (mode-based default via dimmed state).
    if (pathMode !== "mine" || !user?.uid) return new Map<string, string>();
    return computeEdgeColors(edges, pathResult.paths, [user.uid]);
  }, [pathResult, edges, pathMode, user]);

  const myNodeIds = useMemo(() => {
    if (pathMode !== "mine" || !user?.uid || !pathResult) return null;
    const myPath = pathResult.paths.get(user.uid);
    return myPath ? new Set(myPath) : new Set<string>();
  }, [pathMode, user, pathResult]);

  const myEdgeKeys = useMemo(() => {
    if (pathMode !== "mine" || !user?.uid || !pathResult) return null;
    const myPath = pathResult.paths.get(user.uid);
    if (!myPath) return new Set<string>();
    const keys = new Set<string>();
    for (let i = 0; i < myPath.length - 1; i++) {
      keys.add(`${myPath[i]}->${myPath[i + 1]}`);
    }
    return keys;
  }, [pathMode, user, pathResult]);

  const mergeNodeIds = useMemo(() => {
    const reverseAdj = new Map<string, string[]>();
    for (const e of edges) {
      const parents = reverseAdj.get(e.to_node_id) ?? [];
      parents.push(e.from_node_id);
      reverseAdj.set(e.to_node_id, parents);
    }
    const ids = new Set<string>();
    for (const [nodeId, parents] of reverseAdj) {
      if (parents.length > 1) ids.add(nodeId);
    }
    return ids;
  }, [edges]);

  const hasBranches = useMemo(() => {
    // Multiple root nodes count as a branch (starting point divergence)
    const hasParent = new Set<string>();
    const outDeg = new Map<string, number>();
    for (const e of edges) {
      hasParent.add(e.to_node_id);
      outDeg.set(e.from_node_id, (outDeg.get(e.from_node_id) ?? 0) + 1);
    }
    const rootCount = nodes.filter((n) => !hasParent.has(n.id)).length;
    if (rootCount > 1) return true;
    for (const count of outDeg.values()) {
      if (count > 1) return true;
    }
    return false;
  }, [edges, nodes]);

  function handleNodeSelect(nodeId: string) {
    setSelectedEdgeId(null);
    setAddNodePlace(null);
    setSelectedNodeId((prev) => (prev === nodeId ? null : nodeId));
  }

  function handleEdgeSelect(edgeId: string) {
    setSelectedNodeId(null);
    setAddNodePlace(null);
    setSelectedEdgeId((prev) => (prev === edgeId ? null : edgeId));
  }

  function handleMapClick(place: PlaceResult) {
    if (!canEdit) return;
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setAddNodePlace(place);
  }

  async function handleNodeEdit(
    nodeId: string,
    updates: Record<string, unknown>,
  ) {
    if (!displayPlanId) return;
    try {
      const result = await api.patch<{
        node: NodeData;
        cascade_preview: CascadePreviewData;
      }>(`/trips/${tripId}/plans/${displayPlanId}/nodes/${nodeId}`, updates);

      if (result.cascade_preview.affected_nodes.length > 0) {
        setCascadePreview(result.cascade_preview);
        setCascadeNodeId(nodeId);
      }
    } catch {
      // Error handled by api client
    }
  }

  async function handleNodeDelete(nodeId: string) {
    if (!displayPlanId) return;
    try {
      await api.delete(
        `/trips/${tripId}/plans/${displayPlanId}/nodes/${nodeId}`,
      );
      setSelectedNodeId(null);
    } catch {
      // Error handled by api client
    }
  }

  async function handleAddAction(
    nodeId: string,
    data: { type: string; content: string; place_data?: unknown },
  ) {
    if (!displayPlanId) return;
    try {
      await api.post(
        `/trips/${tripId}/plans/${displayPlanId}/nodes/${nodeId}/actions`,
        data,
      );
    } catch {
      // Error handled by api client
    }
  }

  async function handleDeleteAction(nodeId: string, actionId: string) {
    if (!displayPlanId) return;
    try {
      await api.delete(
        `/trips/${tripId}/plans/${displayPlanId}/nodes/${nodeId}/actions/${actionId}`,
      );
    } catch {
      // Error handled by api client
    }
  }

  async function handleToggleAction(
    nodeId: string,
    actionId: string,
    isCompleted: boolean,
  ) {
    if (!displayPlanId) return;
    try {
      await api.patch(
        `/trips/${tripId}/plans/${displayPlanId}/nodes/${nodeId}/actions/${actionId}`,
        { is_completed: isCompleted },
      );
    } catch {
      // Error handled by api client
    }
  }

  async function handleBranch(
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
  ) {
    if (!displayPlanId) return;
    try {
      await api.post(
        `/trips/${tripId}/plans/${displayPlanId}/nodes/${nodeId}/branch`,
        data,
      );
      setSelectedNodeId(null);
    } catch {
      // Error handled by api client
    }
  }

  async function handleAddNode(data: {
    name: string;
    type: string;
    lat: number;
    lng: number;
    place_id: string | null;
    arrival_time: string | null;
    departure_time: string | null;
    connect_after_node_id: string | null;
    connect_before_node_id: string | null;
    travel_mode: string;
    travel_time_hours: number;
    distance_km: number | null;
    route_polyline: string | null;
  }) {
    if (!displayPlanId) return;
    try {
      await api.post(
        `/trips/${tripId}/plans/${displayPlanId}/nodes`,
        data,
      );
      setAddNodePlace(null);
    } catch {
      // Error handled by api client
    }
  }

  async function handleCascadeConfirm() {
    if (!displayPlanId || !cascadeNodeId) return;
    setCascadeLoading(true);
    try {
      await api.post(
        `/trips/${tripId}/plans/${displayPlanId}/nodes/${cascadeNodeId}/cascade/confirm`,
      );
      setCascadePreview(null);
      setCascadeNodeId(null);
    } catch {
      // Error handled by api client
    } finally {
      setCascadeLoading(false);
    }
  }

  if (!displayPlanId) {
    return (
      <div className="flex flex-col flex-1 bg-surface">
        <header className="flex items-center gap-3 px-5 py-4 bg-surface-lowest">
          <Link
            href="/"
            className="h-10 w-10 rounded-full bg-surface-low flex items-center justify-center text-on-surface-variant"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
            </svg>
          </Link>
          <h1 className="text-base font-bold text-on-surface">{trip?.name}</h1>
        </header>
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center px-6">
            <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
              <svg className="h-8 w-8 text-primary" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 6.75V15m6-6v8.25m.503 3.498 4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 0 0-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0Z" />
              </svg>
            </div>
            <p className="text-on-surface-variant font-medium mb-4">
              No plan yet
            </p>
            <Link
              href={`/trips/${tripId}/import`}
              className="inline-flex gradient-primary rounded-full px-6 py-3 text-sm font-semibold text-on-primary shadow-ambient transition-all active:scale-[0.98]"
            >
              Import Itinerary
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full relative" style={{ "--bottom-nav-height": "56px" } as React.CSSProperties}>
      {/* Glass Header */}
      <header className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-4 py-3 glass-panel-dense">
        <div className="flex items-center gap-2">
          <Link
            href="/"
            className="h-9 w-9 rounded-full bg-surface-lowest/80 flex items-center justify-center text-on-surface-variant shadow-soft"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
            </svg>
          </Link>
          <h1 className="text-sm font-bold text-on-surface truncate max-w-[140px]">{trip?.name}</h1>
          <PlanSwitcher
            activePlanId={displayPlanId}
            onPlanSelect={(planId) =>
              setViewedPlanId(planId === activePlanId ? null : planId)
            }
          />
        </div>
        <div className="flex items-center gap-2">
          <NotificationBell tripId={tripId} />
          <ProfileAvatar name={user?.displayName} size="sm" />
        </div>
      </header>

      <div className="absolute top-12 left-0 right-0 z-20">
        <OfflineBanner />
      </div>

      {hasBranches && <PathFilter mode={pathMode} onModeChange={setPathMode} />}

      <div className="flex-1 pt-12 min-h-0">
        {loading ? (
          <div className="flex flex-1 items-center justify-center h-full">
            <div className="h-8 w-8 animate-spin rounded-full border-3 border-surface-high border-t-primary" />
          </div>
        ) : (
          <TripMap
            nodes={nodes}
            edges={edges}
            edgeColors={edgeColors}
            mergeNodeIds={mergeNodeIds}
            myNodeIds={myNodeIds}
            myEdgeKeys={myEdgeKeys}
            onNodeSelect={handleNodeSelect}
            onEdgeSelect={handleEdgeSelect}
            onMapClick={handleMapClick}
            selectedNodeId={selectedNodeId}
            selectedEdgeId={selectedEdgeId}
            skipInitialFit={mapFitted}
            onInitialFitDone={markMapFitted}
            savedCamera={mapCamera}
            onCameraChange={setMapCamera}
            pulseLocations={liveLocations}
            participants={trip?.participants}
            currentUserId={user?.uid}
          />
        )}
      </div>

      {selectedNode && (
        <NodeDetailSheet
          node={selectedNode}
          allNodes={nodes}
          userRole={userRole}
          online={online}
          datetimeFormat={datetimeFormat}
          dateFormat={dateFormat}
          actions={nodeActions}
          actionsLoading={actionsLoading}
          onClose={() => setSelectedNodeId(null)}
          onEdit={handleNodeEdit}
          onDelete={handleNodeDelete}
          onAddAction={handleAddAction}
          onDeleteAction={handleDeleteAction}
          onToggleAction={handleToggleAction}
          onBranch={handleBranch}
        />
      )}

      {selectedEdge && (
        <EdgeDetail
          edge={selectedEdge}
          fromNode={nodeMap.get(selectedEdge.from_node_id)}
          toNode={nodeMap.get(selectedEdge.to_node_id)}
          distanceUnit={distanceUnit}
          timingWarning={selectedEdgeWarning.hasWarning}
          warningMessage={selectedEdgeWarning.message}
          onClose={() => setSelectedEdgeId(null)}
        />
      )}

      {addNodePlace && (
        <AddNodeSheet
          initialPlace={addNodePlace}
          allNodes={nodes}
          datetimeFormat={datetimeFormat}
          dateFormat={dateFormat}
          onSubmit={handleAddNode}
          onCancel={() => setAddNodePlace(null)}
        />
      )}

      {cascadePreview && (
        <CascadePreview
          preview={cascadePreview}
          nodeTimezones={Object.fromEntries(
            nodes
              .filter((n) => n.timezone)
              .map((n) => [n.id, n.timezone as string]),
          )}
          loading={cascadeLoading}
          onConfirm={handleCascadeConfirm}
          onCancel={() => {
            setCascadePreview(null);
            setCascadeNodeId(null);
          }}
        />
      )}

      {/* DivergenceResolver — floats above bottom nav */}
      {displayPlanId && user && edges.length > 0 && (
        <DivergenceResolver
          tripId={tripId}
          planId={displayPlanId}
          nodes={nodes}
          edges={edges}
          unresolved={pathResult?.unresolved ?? []}
          myPath={pathResult?.paths.get(user.uid) ?? null}
          participants={trip?.participants ?? {}}
          currentUserId={user.uid}
          userRole={userRole}
          hidden={
            !!selectedNode ||
            !!selectedEdge ||
            !!addNodePlace ||
            !!cascadePreview
          }
        />
      )}

      {/* Bottom nav */}
      <BottomNav
        tripId={tripId}
        activeTab={activeTab}
        onTabChange={handleTabChange}
        onPulseToast={setToastMessage}
      />

      {/* Agent overlay */}
      <AgentOverlay
        tripId={tripId}
        tripName={trip?.name}
        planId={displayPlanId}
        open={activeTab === "agent"}
        onClose={() => setActiveTab("map")}
      />

      {/* Toast */}
      <Toast
        message={toastMessage}
        duration={5000}
        onDismiss={handleToastDismiss}
      />
    </div>
  );
}
