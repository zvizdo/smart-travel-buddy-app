"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useTripContext, type PlanData } from "@/app/trips/[tripId]/layout";
import { useAuth } from "@/components/auth/auth-provider";
import { api } from "@/lib/api";
import { usePulseLocations, useNodeActions } from "@/lib/firestore-hooks";
import { useEnrichedNodes } from "@/lib/use-enriched-nodes";
import type { TripSettingsLike } from "@/lib/time-inference";
import { TripMap } from "@/components/map/trip-map";
import { NodeDetailSheet } from "@/components/dag/node-detail-sheet";
import { EdgeDetail } from "@/components/dag/edge-detail";
import { NotificationBell } from "@/components/ui/notification-bell";
import { PathFilter } from "@/components/map/path-filter";
import { CreateNodeForm, type CreateContext } from "@/components/dag/create-node-form";
import { type PlaceResult } from "@/components/map/places-autocomplete";
import { DivergenceResolver } from "@/components/dag/divergence-resolver";
import {
  computeParticipantPaths,
  computeEdgeColors,
} from "@/lib/path-computation";
import { PlanSwitcher } from "@/components/dag/plan-switcher";
import { CreateDraftOverlay } from "@/components/dag/create-draft-overlay";
import { OfflineBanner, useOnlineStatus } from "@/components/ui/offline-banner";
import { flushQueue } from "@/lib/offline-queue";
import {
  pruneResolvedPending,
  filterOutPendingNodes,
  filterOutPendingEdges,
} from "@/lib/pending-set";
import { BottomNav } from "@/components/ui/bottom-nav";
import { toast } from "@/components/ui/toast";
import { ProfileAvatar } from "@/components/ui/profile-avatar";
import { AgentOverlay } from "@/components/chat/agent-overlay";
import { EdgeDisambiguationPicker } from "@/components/dag/edge-disambiguation-picker";
import { TimelineView } from "@/components/timeline/timeline-view";
import { TimelineViewToggle } from "@/components/timeline/timeline-view-toggle";
import type { TimelineZoomLevel } from "@/lib/timeline-layout";
import { haversineKm } from "@/lib/geo";
import {
  trackDagMutation,
  trackEdgeOpened,
  trackNodeAction,
  trackNodeOpened,
  trackPathModeToggled,
  trackPlanCreated,
  trackTimelineZoomChanged,
  trackTimingShifted,
  trackViewChanged,
} from "@/lib/analytics";

interface NodeData {
  id: string;
  name: string;
  type: string;
  lat_lng: { lat: number; lng: number } | null;
  arrival_time: string | null;
  departure_time: string | null;
  duration_minutes?: number | null;
  participant_ids?: string[] | null;
  timezone?: string | null;
  // Enrichment flags appended by `useEnrichedNodes` / `enrichDagTimes`.
  arrival_time_estimated?: boolean;
  departure_time_estimated?: boolean;
  duration_estimated?: boolean;
  timing_conflict?: string | null;
  timing_conflict_severity?: "info" | "advisory" | "error" | null;
  hold_reason?: "night_drive" | "max_drive_hours" | null;
  is_start?: boolean;
  is_end?: boolean;
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

interface ImpactShift {
  id: string;
  name: string;
  old_arrival: string | null;
  new_arrival: string | null;
}

interface ImpactConflict {
  id: string;
  name: string;
  message: string;
}

interface ImpactOvernightHold {
  id: string;
  reason: "night_drive" | "max_drive_hours";
}

interface ImpactPreview {
  estimated_shifts: ImpactShift[];
  new_conflicts: ImpactConflict[];
  new_overnight_holds: ImpactOvernightHold[];
}

export default function TripMapPage() {
  const { tripId, trip, plans, mapCamera, setMapCamera, viewedPlanId, setViewedPlanId, setPlans } = useTripContext();
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

  if (
    viewedPlanId &&
    plans.length > 0 &&
    !plans.some((p) => p.id === viewedPlanId)
  ) {
    setViewedPlanId(null);
  }

  const enrichmentSettings = useMemo<TripSettingsLike>(
    () => ({
      no_drive_window: trip?.settings?.no_drive_window ?? null,
      max_drive_hours_per_day: trip?.settings?.max_drive_hours_per_day ?? null,
    }),
    [trip?.settings?.no_drive_window, trip?.settings?.max_drive_hours_per_day],
  );

  const {
    nodes: liveNodes,
    edges: liveEdges,
    loading: enrichmentLoading,
  } = useEnrichedNodes(tripId, displayPlanId, enrichmentSettings);

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

  const allLiveNodes = liveNodes as unknown as NodeData[];
  const allLiveEdges = liveEdges as unknown as EdgeData[];
  const loading = enrichmentLoading;

  // Optimistically-deleted node IDs — hidden from UI immediately. Connected
  // edges are also filtered out to mirror the backend's cascade delete.
  // Cleared once Firestore snapshot confirms the removal (same pattern as
  // deletedActionIds).
  const [pendingNodeDeletes, setPendingNodeDeletes] = useState<Set<string>>(
    () => new Set(),
  );
  useEffect(() => {
    setPendingNodeDeletes((prev) =>
      pruneResolvedPending(
        prev,
        allLiveNodes.map((n) => n.id),
      ),
    );
  }, [allLiveNodes]);

  const nodes = useMemo(
    () => filterOutPendingNodes(allLiveNodes, pendingNodeDeletes),
    [allLiveNodes, pendingNodeDeletes],
  );
  const edges = useMemo(
    () => filterOutPendingEdges(allLiveEdges, pendingNodeDeletes),
    [allLiveEdges, pendingNodeDeletes],
  );

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [disambiguationEdges, setDisambiguationEdges] = useState<EdgeData[] | null>(null);

  const { data: nodeActions, loading: actionsLoading } = useNodeActions(
    tripId,
    displayPlanId,
    selectedNodeId,
  );

  // Optimistically-deleted action IDs — hidden from UI immediately on delete.
  // Cleared once the Firestore snapshot reflects the deletion (id no longer in data).
  const [deletedActionIds, setDeletedActionIds] = useState<Set<string>>(
    () => new Set(),
  );
  useEffect(() => {
    setDeletedActionIds((prev) =>
      pruneResolvedPending(
        prev,
        nodeActions.map((a) => a.id),
      ),
    );
  }, [nodeActions]);
  const visibleNodeActions = useMemo(
    () => nodeActions.filter((a) => !deletedActionIds.has(a.id)),
    [nodeActions, deletedActionIds],
  );

  // Context-aware initial map focal point: prioritizes user's location if
  // near a stop, then next upcoming stop, then trip start, then fitBounds.
  const initialFocalPoint = useMemo<{
    lat: number;
    lng: number;
    zoom: number;
  } | null>(() => {
    if (nodes.length === 0 || nodes.length > 15) return null;

    const now = Date.now();
    const nodesWithCoords = nodes.filter((n) => n.lat_lng);
    if (nodesWithCoords.length === 0) return null;

    const allTimes = nodes
      .flatMap((n) => [n.arrival_time, n.departure_time])
      .filter(Boolean)
      .map((t) => new Date(t!).getTime());
    const tripStart = allTimes.length > 0 ? Math.min(...allTimes) : null;
    const tripEnd = allTimes.length > 0 ? Math.max(...allTimes) : null;

    const tripInProgress =
      tripStart != null && tripEnd != null && now >= tripStart && now <= tripEnd;
    const tripOver = tripEnd != null && now > tripEnd;

    // Priority 1: Trip in progress + user near a stop (<50km)
    if (tripInProgress && liveLocations.length > 0) {
      const myLoc = liveLocations.find((l) => l.user_id === user?.uid);
      const coords = myLoc?.coords as
        | { lat: number; lng: number }
        | undefined;
      if (coords?.lat && coords?.lng) {
        let nearest: NodeData | null = null;
        let nearestDist = Infinity;
        for (const n of nodesWithCoords) {
          const d = haversineKm(coords, n.lat_lng!);
          if (d < nearestDist) {
            nearestDist = d;
            nearest = n;
          }
        }
        if (nearest && nearestDist < 50) {
          return { lat: nearest.lat_lng!.lat, lng: nearest.lat_lng!.lng, zoom: 12 };
        }
      }
    }

    // Priority 2: Trip in progress → next upcoming stop
    if (tripInProgress) {
      const upcoming = nodesWithCoords
        .filter((n) => {
          const t = n.arrival_time
            ? new Date(n.arrival_time).getTime()
            : n.departure_time
              ? new Date(n.departure_time).getTime()
              : null;
          return t != null && t > now;
        })
        .sort((a, b) => {
          const ta = new Date(
            (a.arrival_time ?? a.departure_time)!,
          ).getTime();
          const tb = new Date(
            (b.arrival_time ?? b.departure_time)!,
          ).getTime();
          return ta - tb;
        });
      if (upcoming.length > 0) {
        return {
          lat: upcoming[0].lat_lng!.lat,
          lng: upcoming[0].lat_lng!.lng,
          zoom: 11,
        };
      }
    }

    // Priority 3: Trip hasn't started (or no timing) → first stop (root node)
    if (!tripOver) {
      const childIds = new Set(edges.map((e) => e.to_node_id));
      const roots = nodesWithCoords
        .filter((n) => !childIds.has(n.id))
        .sort((a, b) => {
          const ta = a.departure_time
            ? new Date(a.departure_time).getTime()
            : Infinity;
          const tb = b.departure_time
            ? new Date(b.departure_time).getTime()
            : Infinity;
          return ta - tb;
        });
      if (roots.length > 0) {
        return { lat: roots[0].lat_lng!.lat, lng: roots[0].lat_lng!.lng, zoom: 11 };
      }
    }

    // Priority 4: Trip is over → null (fitBounds for review)
    return null;
  }, [nodes, edges, liveLocations, user?.uid]);

  const [pathMode, setPathMode] = useState<"all" | "mine">("all");
  const pathModeInitialized = useRef(false);
  // Tracks whether the path mode decision has been made (so map can wait for it)
  const [pathModeReady, setPathModeReady] = useState(false);

  const [addNodePlace, setAddNodePlace] = useState<PlaceResult | null>(null);
  const [insertEdgeId, setInsertEdgeId] = useState<string | null>(null);
  const [recalculatingEdges, setRecalculatingEdges] = useState<Set<string>>(new Set());

  // Clear recalculating state when edges update from Firestore.
  // Tracks a composite key of all route-related fields so it detects
  // polyline changes (drive/transit), time/distance changes (flights),
  // and route_updated_at changes (failure signaling).
  const prevEdgeRouteKeysRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const prev = prevEdgeRouteKeysRef.current;
    const changed: string[] = [];
    for (const e of edges) {
      const raw = e as Record<string, unknown>;
      const key = `${raw.route_polyline}|${raw.travel_time_hours}|${raw.distance_km}|${raw.route_updated_at}`;
      if (prev.has(e.id) && prev.get(e.id) !== key) {
        changed.push(e.id);
      }
      prev.set(e.id, key);
    }
    if (changed.length > 0) {
      setRecalculatingEdges((s) => {
        const next = new Set(s);
        for (const id of changed) next.delete(id);
        return next.size === s.size ? s : next;
      });
    }
  }, [edges]);

  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const viewMode = searchParams.get("view") === "timeline" ? "timeline" : "map";
  const setViewMode = useCallback(
    (mode: "map" | "timeline") => {
      const params = new URLSearchParams(searchParams.toString());
      const from = params.get("view") === "timeline" ? "timeline" : "map";
      if (mode === "timeline") {
        params.set("view", "timeline");
      } else {
        params.delete("view");
      }
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
      if (from !== mode) trackViewChanged(from, mode);
    },
    [searchParams, router, pathname],
  );
  const [timelineZoom, setTimelineZoomState] = useState<TimelineZoomLevel>(2);
  const setTimelineZoom = useCallback<
    React.Dispatch<React.SetStateAction<TimelineZoomLevel>>
  >((value) => {
    setTimelineZoomState((prev) => {
      const next =
        typeof value === "function"
          ? (value as (p: TimelineZoomLevel) => TimelineZoomLevel)(prev)
          : value;
      if (next !== prev) trackTimelineZoomChanged(next);
      return next;
    });
  }, []);

  const [activeTab, setActiveTab] = useState<"map" | "agent" | "settings">("map");
  const [showCreateDraft, setShowCreateDraft] = useState(false);

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

  const isViewingActivePlan = displayPlanId === activePlanId;
  const plannerReadOnly = userRole === "planner" && isViewingActivePlan;
  const canEdit = online && (userRole === "admin" || (userRole === "planner" && !isViewingActivePlan));

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
          message: `Arrival is ${deficitStr} too early for the estimated travel time`,
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

  // Default to "my path" view when the user has any resolved path choices.
  // Also signals pathModeReady so the map can wait for this decision before fitting bounds.
  useEffect(() => {
    if (pathModeInitialized.current) return;

    // If there's no branching DAG or no user yet, path mode stays "all" — mark ready
    if (!pathResult || !user?.uid) {
      // Only mark ready once nodes have loaded (pathResult is null for 0 nodes/edges)
      if (!loading) setPathModeReady(true);
      return;
    }

    pathModeInitialized.current = true;

    const myPath = pathResult.paths.get(user.uid);
    if (!myPath || myPath.length === 0) {
      setPathModeReady(true);
      return;
    }

    // Check if the user has explicitly chosen at any divergence
    const hasAnyChoice = nodes.some((node) => {
      const pids = node.participant_ids;
      return pids && pids.includes(user.uid);
    });

    if (hasAnyChoice) {
      setPathMode("mine");
    }
    setPathModeReady(true);
  }, [pathResult, user, nodes, loading]);

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
    setDisambiguationEdges(null);
    setSelectedNodeId((prev) => {
      if (prev === nodeId) return null;
      const node = nodes.find((n) => n.id === nodeId);
      trackNodeOpened(node?.type);
      return nodeId;
    });
  }

  function handleEdgeSelect(edgeId: string, overlappingEdgeIds?: string[]) {
    setSelectedNodeId(null);
    setAddNodePlace(null);

    // Toggle off if already selected
    if (selectedEdgeId === edgeId) {
      setSelectedEdgeId(null);
      return;
    }

    // Multiple edges near tap point — show disambiguation picker
    if (overlappingEdgeIds && overlappingEdgeIds.length > 0) {
      const allIds = [edgeId, ...overlappingEdgeIds];
      const allEdges = allIds
        .map((id) => edges.find((e) => e.id === id))
        .filter((e): e is EdgeData => e != null);
      setSelectedEdgeId(null);
      setDisambiguationEdges(allEdges);
    } else {
      setDisambiguationEdges(null);
      setSelectedEdgeId(edgeId);
      const edge = edges.find((e) => e.id === edgeId);
      trackEdgeOpened(edge?.travel_mode);
    }
  }

  function handleCloneToDraft() {
    setShowCreateDraft(true);
  }

  async function handleCreateDraft(name: string) {
    if (!activePlanId) return;
    setShowCreateDraft(false);
    try {
      const result = await api.post<{ plan: PlanData }>(
        `/trips/${tripId}/plans`,
        { source_plan_id: activePlanId, name },
      );
      setPlans((prev) => [...prev, result.plan]);
      setViewedPlanId(result.plan.id);
      trackPlanCreated();
      toast("Draft created. You're now editing your draft.");
    } catch (err) {
      toast({
        message:
          err instanceof Error && err.message
            ? `Couldn't create draft: ${err.message}`
            : "Couldn't create draft",
        variant: "error",
      });
    }
  }

  function handleMapClick(place: PlaceResult) {
    if (plannerReadOnly) {
      toast("Switch to a draft plan to add stops.");
      return;
    }
    if (!canEdit) return;
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setDisambiguationEdges(null);
    setAddNodePlace(place);
    // Keep insertEdgeId if in insert mode — the CreateNodeForm will use it
  }

  async function handleNodeEdit(
    nodeId: string,
    updates: Record<string, unknown>,
  ) {
    if (!displayPlanId) return;

    // Track recalculating edges only when location actually changes
    let locationChanged = false;
    if (updates.lat != null || updates.lng != null) {
      const currentNode = nodes.find((n) => n.id === nodeId);
      if (currentNode?.lat_lng) {
        locationChanged =
          updates.lat !== currentNode.lat_lng.lat ||
          updates.lng !== currentNode.lat_lng.lng;
      } else {
        locationChanged = true;
      }
    }
    if (locationChanged) {
      const connectedEdgeIds = edges
        .filter((e) => e.from_node_id === nodeId || e.to_node_id === nodeId)
        .map((e) => e.id);
      if (connectedEdgeIds.length > 0) {
        setRecalculatingEdges((prev) => {
          const next = new Set(prev);
          for (const id of connectedEdgeIds) next.add(id);
          return next;
        });
      }
    }

    try {
      // The PATCH response carries an `impact_preview` diff produced by
      // `enrich_dag_times(before)` vs `enrich_dag_times(after)`. The live
      // impact panel in the edit sheet consumes it directly; page-level just
      // awaits so the shimmer clears when the server write settles.
      await api.patch<{
        node: NodeData;
        impact_preview: ImpactPreview;
        conflict: boolean;
      }>(`/trips/${tripId}/plans/${displayPlanId}/nodes/${nodeId}`, updates);
      trackDagMutation({
        source: "ui",
        action: "edit",
        entity: "node",
        fields_changed: Object.keys(updates).join(","),
      });
    } catch (err) {
      // Clear shimmer so the edge doesn't spin forever on save failure.
      if (locationChanged) {
        const connectedEdgeIds = edges
          .filter((e) => e.from_node_id === nodeId || e.to_node_id === nodeId)
          .map((e) => e.id);
        setRecalculatingEdges((prev) => {
          const next = new Set(prev);
          for (const id of connectedEdgeIds) next.delete(id);
          return next;
        });
      }
      const msg =
        err instanceof Error && err.message ? err.message : "Update failed";
      toast({
        message: `Couldn't save changes: ${msg}`,
        variant: "error",
        action: {
          label: "Retry",
          onClick: () => {
            void handleNodeEdit(nodeId, updates);
          },
        },
      });
    }
  }

  async function handleNodeDelete(nodeId: string) {
    if (!displayPlanId) return;
    // Optimistic remove: add to pending set (filters from visible nodes+edges)
    // and close the sheet so the user sees instant feedback. Firestore
    // snapshot will confirm within ~200ms and the cleanup effect drops the id.
    setPendingNodeDeletes((prev) => {
      const next = new Set(prev);
      next.add(nodeId);
      return next;
    });
    setSelectedNodeId(null);
    try {
      await api.delete(
        `/trips/${tripId}/plans/${displayPlanId}/nodes/${nodeId}`,
      );
      trackDagMutation({ source: "ui", action: "delete", entity: "node" });
    } catch (err) {
      // Rollback: the node reappears in the UI. Surface an error with Retry.
      setPendingNodeDeletes((prev) => {
        if (!prev.has(nodeId)) return prev;
        const next = new Set(prev);
        next.delete(nodeId);
        return next;
      });
      const msg =
        err instanceof Error && err.message ? err.message : "Delete failed";
      toast({
        message: `Couldn't delete stop: ${msg}`,
        variant: "error",
        action: {
          label: "Retry",
          onClick: () => {
            void handleNodeDelete(nodeId);
          },
        },
      });
    }
  }

  async function handleShiftFollowing(
    shifts: Array<{
      id: string;
      arrival_time: string | null;
      departure_time: string | null;
    }>,
  ) {
    if (!displayPlanId || shifts.length === 0) return;
    for (const s of shifts) {
      try {
        await api.patch(
          `/trips/${tripId}/plans/${displayPlanId}/nodes/${s.id}`,
          {
            arrival_time: s.arrival_time,
            departure_time: s.departure_time,
          },
        );
      } catch {
        // Error surfaced by api client; keep iterating so partial success still applies.
      }
    }
    trackTimingShifted(shifts.length);
    toast(
      shifts.length === 1
        ? "Shifted 1 following stop"
        : `Shifted ${shifts.length} following stops`,
    );
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
      trackNodeAction({ action: "added", action_type: data.type, source: "ui" });
    } catch {
      // Error handled by api client
    }
  }

  async function handleDeleteAction(nodeId: string, actionId: string) {
    if (!displayPlanId) return;
    // Optimistically hide the action; the snapshot cleanup effect will drop
    // the id from the set once Firestore confirms deletion.
    setDeletedActionIds((prev) => {
      const next = new Set(prev);
      next.add(actionId);
      return next;
    });
    try {
      await api.delete(
        `/trips/${tripId}/plans/${displayPlanId}/nodes/${nodeId}/actions/${actionId}`,
      );
      trackNodeAction({ action: "deleted", action_type: "unknown", source: "ui" });
    } catch {
      // Revert optimistic hide on failure so the item reappears.
      setDeletedActionIds((prev) => {
        const next = new Set(prev);
        next.delete(actionId);
        return next;
      });
    }
  }

  async function handleToggleAction(
    nodeId: string,
    actionId: string,
    isCompleted: boolean,
  ) {
    if (!displayPlanId) return;
    // Let errors propagate so ActionList can revert its optimistic state.
    await api.patch(
      `/trips/${tripId}/plans/${displayPlanId}/nodes/${nodeId}/actions/${actionId}`,
      { is_completed: isCompleted },
    );
    trackNodeAction({ action: "toggled", action_type: "todo", source: "ui" });
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
      duration_minutes: number | null;
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
      trackDagMutation({
        source: "ui",
        action: "branch",
        entity: "node",
        node_type: data.type,
        travel_mode: data.travel_mode,
      });
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
    duration_minutes: number | null;
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
      trackDagMutation({
        source: "ui",
        action: "create",
        entity: "node",
        node_type: data.type,
        travel_mode: data.travel_mode,
      });
      setAddNodePlace(null);
      setInsertEdgeId(null);
    } catch {
      // Error handled by api client
    }
  }

  function handleInsertStop() {
    if (!selectedEdge || !canEdit) return;
    // Keep the edge selected, open a map click handler
    setInsertEdgeId(selectedEdge.id);
    setSelectedEdgeId(null);
    if (viewMode === "map") {
      toast("Tap the map to place your new stop");
    }
  }

  async function handleEdgeRefresh() {
    if (!selectedEdge) return;
    const edgeId = selectedEdge.id;
    setRecalculatingEdges((prev) => new Set([...prev, edgeId]));
    try {
      await api.post(`/trips/${tripId}/plans/${displayPlanId}/edges/${edgeId}/refresh`);
    } catch (err) {
      setRecalculatingEdges((prev) => {
        const next = new Set(prev);
        next.delete(edgeId);
        return next;
      });
      const msg =
        err instanceof Error && err.message ? err.message : "Refresh failed";
      toast({ message: `Couldn't refresh route: ${msg}`, variant: "error" });
    }
  }

  function handleTimelineInsertStop(edgeId: string) {
    if (!canEdit) return;
    setInsertEdgeId(edgeId);
    setSelectedEdgeId(null);
    // In timeline mode, open CreateNodeForm in search-first mode (no map tap needed)
    setAddNodePlace({ name: "", placeId: "", lat: 0, lng: 0, types: [] } as PlaceResult);
  }

  function handleTimelineAddNode() {
    if (!canEdit) return;
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setAddNodePlace({ name: "", placeId: "", lat: 0, lng: 0, types: [] } as PlaceResult);
  }

  function handleDisambiguationPick(edgeId: string) {
    setDisambiguationEdges(null);
    setSelectedEdgeId(edgeId);
  }

  function handleDisambiguationClose() {
    setDisambiguationEdges(null);
  }

  const insertBetween = useMemo(() => {
    if (!insertEdgeId) return null;
    const edge = edges.find((e) => e.id === insertEdgeId);
    if (!edge) return null;
    const fromNode = nodes.find((n) => n.id === edge.from_node_id);
    const toNode = nodes.find((n) => n.id === edge.to_node_id);
    if (!fromNode || !toNode) return null;
    return { edgeId: insertEdgeId, fromNode, toNode };
  }, [insertEdgeId, edges, nodes]);

  async function handleSplitEdge(edgeId: string, data: {
    name: string;
    type: string;
    lat: number;
    lng: number;
    place_id: string | null;
    arrival_time: string | null;
    departure_time: string | null;
    duration_minutes: number | null;
    leg_a: { travel_mode: string; travel_time_hours: number | null; distance_km: number | null; route_polyline: string | null } | null;
    leg_b: { travel_mode: string; travel_time_hours: number | null; distance_km: number | null; route_polyline: string | null } | null;
  }) {
    if (!displayPlanId) return;
    try {
      await api.post(
        `/trips/${tripId}/plans/${displayPlanId}/edges/${edgeId}/split`,
        data,
      );
      trackDagMutation({
        source: "ui",
        action: "split",
        entity: "edge",
        node_type: data.type,
      });
      setAddNodePlace(null);
      setInsertEdgeId(null);
    } catch {
      // Error handled by api client
    }
  }

  async function handleSubmitConnected(data: {
    name: string;
    type: string;
    lat: number;
    lng: number;
    place_id: string | null;
    arrival_time: string | null;
    departure_time: string | null;
    duration_minutes: number | null;
    incoming: { node_id: string; travel_mode: string; travel_time_hours: number; distance_km: number | null; route_polyline: string | null }[];
    outgoing: { node_id: string; travel_mode: string; travel_time_hours: number; distance_km: number | null; route_polyline: string | null }[];
  }) {
    if (!displayPlanId) return;
    try {
      await api.post(
        `/trips/${tripId}/plans/${displayPlanId}/nodes/connected`,
        data,
      );
      trackDagMutation({
        source: "ui",
        action: "insert",
        entity: "node",
        node_type: data.type,
      });
      setAddNodePlace(null);
    } catch (err: unknown) {
      const error = err as { error?: { code?: string; message?: string } };
      if (error?.error?.code === "CYCLE_DETECTED") {
        toast({
          message: "This connection would create a loop — routes can't circle back.",
          variant: "error",
        });
      }
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
              No itinerary yet
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
    <div className="flex flex-col h-full relative overflow-hidden" style={{ "--bottom-nav-height": "56px" } as React.CSSProperties}>
      {/* Glass Header */}
      <header className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-4 py-3 glass-panel-dense">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Link
            href="/"
            className="h-9 w-9 rounded-full bg-surface-lowest/80 flex items-center justify-center text-on-surface-variant shadow-soft shrink-0"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
            </svg>
          </Link>
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-bold text-on-surface truncate">{trip?.name}</h1>
            {viewedPlanId && viewedPlanId !== activePlanId && (
              <p className="text-[10px] text-on-surface-variant truncate">
                {plans.find((p: PlanData) => p.id === viewedPlanId)?.name ?? "Draft"}
              </p>
            )}
          </div>
          <PlanSwitcher
            activePlanId={displayPlanId}
            onPlanSelect={(planId) =>
              setViewedPlanId(planId === activePlanId ? null : planId)
            }
            userRole={userRole}
            onCreateDraft={handleCloneToDraft}
            isViewingDraft={!!viewedPlanId && viewedPlanId !== activePlanId}
          />
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-2">
          <NotificationBell tripId={tripId} />
          <ProfileAvatar name={user?.displayName} size="sm" />
        </div>
      </header>

      {/* Sub-toolbar: view toggle + path filter */}
      <div className="absolute top-[60px] left-0 right-0 z-10 flex items-center justify-between px-4 py-1.5">
        <TimelineViewToggle viewMode={viewMode} onToggle={setViewMode} />
        {hasBranches && (
          <PathFilter
            mode={pathMode}
            onModeChange={(mode) => {
              setPathMode(mode);
              trackPathModeToggled(mode);
            }}
          />
        )}
      </div>

      <div className="absolute top-[104px] left-0 right-0 z-20">
        <OfflineBanner />
      </div>

      <div className="flex-1 pt-[104px] min-h-0">
        {loading ? (
          <div className="flex flex-1 items-center justify-center h-full">
            <div className="h-8 w-8 animate-spin rounded-full border-3 border-surface-high border-t-primary" />
          </div>
        ) : (
          <>
            <div className={viewMode === "timeline" ? "hidden" : "h-full"}>
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
                planId={displayPlanId}
                readyForInitialFit={pathModeReady}
                initialFocalPoint={initialFocalPoint}
                savedCamera={mapCamera}
                onCameraChange={setMapCamera}
                pulseLocations={liveLocations}
                participants={trip?.participants}
                currentUserId={user?.uid}
                distanceUnit={distanceUnit}
                recalculatingEdges={recalculatingEdges}
              />
            </div>
            <div className={viewMode === "map" ? "hidden" : "h-full"}>
              <TimelineView
                tripId={tripId}
                nodes={nodes}
                edges={edges}
                pathResult={pathResult}
                pathMode={pathMode}
                currentUserId={user?.uid ?? null}
                participants={trip?.participants ?? {}}
                selectedNodeId={selectedNodeId}
                selectedEdgeId={selectedEdgeId}
                onNodeSelect={handleNodeSelect}
                onEdgeSelect={handleEdgeSelect}
                onInsertStop={handleTimelineInsertStop}
                onAddNodeRequest={handleTimelineAddNode}
                canEdit={canEdit}
                datetimeFormat={datetimeFormat}
                dateFormat={dateFormat}
                distanceUnit={distanceUnit}
                zoomLevel={timelineZoom}
                onZoomChange={setTimelineZoom}
              />
            </div>
          </>
        )}
      </div>

      {selectedNode && (
        <NodeDetailSheet
          node={selectedNode}
          allNodes={nodes}
          allEdges={edges}
          tripSettings={enrichmentSettings}
          userRole={userRole}
          online={online}
          plannerReadOnly={plannerReadOnly}
          datetimeFormat={datetimeFormat}
          dateFormat={dateFormat}
          actions={visibleNodeActions}
          actionsLoading={actionsLoading}
          onClose={() => setSelectedNodeId(null)}
          onEdit={handleNodeEdit}
          onDelete={handleNodeDelete}
          onAddAction={handleAddAction}
          onDeleteAction={handleDeleteAction}
          onToggleAction={handleToggleAction}
          onBranch={handleBranch}
          onProposeChanges={handleCloneToDraft}
          onShiftFollowing={handleShiftFollowing}
          onImpactDiscarded={() => toast("Edit discarded")}
        />
      )}

      {selectedEdge && !disambiguationEdges && (
        <EdgeDetail
          edge={selectedEdge}
          fromNode={nodeMap.get(selectedEdge.from_node_id)}
          toNode={nodeMap.get(selectedEdge.to_node_id)}
          distanceUnit={distanceUnit}
          timingWarning={selectedEdgeWarning.hasWarning}
          warningMessage={selectedEdgeWarning.message}
          notes={(selectedEdge.notes as string) ?? null}
          canEdit={canEdit}
          onInsertStop={handleInsertStop}
          onRefresh={userRole === "admin" ? handleEdgeRefresh : undefined}
          refreshing={
            selectedEdge ? recalculatingEdges.has(selectedEdge.id) : false
          }
          onClose={() => setSelectedEdgeId(null)}
        />
      )}

      {disambiguationEdges && (
        <EdgeDisambiguationPicker
          edges={disambiguationEdges}
          nodeMap={nodeMap}
          distanceUnit={distanceUnit}
          onPick={handleDisambiguationPick}
          onClose={handleDisambiguationClose}
        />
      )}

      {addNodePlace && (
        <CreateNodeForm
          context={
            insertBetween
              ? { type: "insert", edgeId: insertBetween.edgeId, fromNode: insertBetween.fromNode, toNode: insertBetween.toNode }
              : { type: "standalone" }
          }
          initialPlace={addNodePlace}
          allNodes={nodes}
          allEdges={edges}
          datetimeFormat={datetimeFormat}
          dateFormat={dateFormat}
          onSubmit={handleAddNode}
          onSplitEdge={handleSplitEdge}
          onSubmitConnected={handleSubmitConnected}
          onCancel={() => { setAddNodePlace(null); setInsertEdgeId(null); }}
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
            !!insertEdgeId ||
            !!disambiguationEdges ||
            viewMode === "timeline"
          }
        />
      )}

      {/* Bottom nav */}
      <BottomNav
        tripId={tripId}
        activeTab={activeTab}
        onTabChange={handleTabChange}
        onPulseToast={(msg) => toast(msg)}
        showPulse={trip?.participants[user?.uid ?? ""]?.location_tracking_enabled === true}
      />

      {/* Agent overlay */}
      <AgentOverlay
        tripId={tripId}
        tripName={trip?.name}
        planId={displayPlanId}
        open={activeTab === "agent"}
        onClose={() => setActiveTab("map")}
      />

      {/* Create draft overlay */}
      {showCreateDraft && (
        <CreateDraftOverlay
          onSubmit={handleCreateDraft}
          onCancel={() => setShowCreateDraft(false)}
        />
      )}

    </div>
  );
}
