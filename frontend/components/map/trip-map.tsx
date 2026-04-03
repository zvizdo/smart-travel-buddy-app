"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Map as GoogleMap,
  type MapMouseEvent,
  useMap,
  useMapsLibrary,
} from "@vis.gl/react-google-maps";
import { type DocumentData } from "firebase/firestore";
import { NodeMarker, TYPE_TOKENS, FALLBACK_TOKEN } from "@/components/map/node-marker";
import { EdgePolyline } from "@/components/map/edge-polyline";
import { FanOutTether } from "@/components/map/fan-out-tether";
import { PulseAvatars } from "@/components/map/pulse-avatars";
import { type PlaceResult } from "@/components/map/places-autocomplete";

interface TripMapProps {
  nodes: DocumentData[];
  edges: DocumentData[];
  edgeColors?: Map<string, string>;
  mergeNodeIds?: Set<string>;
  myNodeIds?: Set<string> | null;
  myEdgeKeys?: Set<string> | null;
  onNodeSelect?: (nodeId: string) => void;
  onEdgeSelect?: (edgeId: string, overlappingEdgeIds?: string[]) => void;
  onMapClick?: (place: PlaceResult) => void;
  selectedNodeId?: string | null;
  selectedEdgeId?: string | null;
  skipInitialFit?: boolean;
  onInitialFitDone?: () => void;
  savedCamera?: { center: { lat: number; lng: number }; zoom: number } | null;
  onCameraChange?: (camera: { center: { lat: number; lng: number }; zoom: number }) => void;
  pulseLocations?: DocumentData[];
  participants?: Record<string, { role: string; display_name?: string; location_tracking_enabled?: boolean }>;
  currentUserId?: string;
  distanceUnit?: "km" | "mi";
  recalculatingEdges?: Set<string>;
}

/** Minimum pixel distance between any two nodes before they start scaling down */
const MIN_PX_PROXIMITY = 60;
/** Below this pixel distance, nodes reach minimum scale */
const COMPACT_PX_THRESHOLD = 25;
/** Minimum scale factor for compact nodes */
const MIN_SCALE = 0.6;
/** Pixel distance below which co-located nodes get spread into a fan pattern */
const FAN_OUT_THRESHOLD = 45;
/** Pixel radius of the fan-out circle */
const FAN_OUT_RADIUS = 32;
/** Maximum pixel drift from a node's real position (bounded displacement) */
const MAX_DRIFT_PX = 60;
/** Minimum pixel separation between any two final marker positions */
const MIN_SEPARATION = 38;

/**
 * Compute pixel distance between two lat/lng points at the current map zoom/projection.
 */
function getPixelDistance(
  map: google.maps.Map,
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const projection = map.getProjection();
  if (!projection) return Infinity;
  const zoom = map.getZoom() ?? 1;
  const scale = Math.pow(2, zoom);

  const pA = projection.fromLatLngToPoint(new google.maps.LatLng(a.lat, a.lng));
  const pB = projection.fromLatLngToPoint(new google.maps.LatLng(b.lat, b.lng));
  if (!pA || !pB) return Infinity;

  const dx = (pA.x - pB.x) * scale;
  const dy = (pA.y - pB.y) * scale;
  return Math.sqrt(dx * dx + dy * dy);
}

export function TripMap({
  nodes,
  edges,
  edgeColors,
  mergeNodeIds,
  myNodeIds,
  myEdgeKeys,
  onNodeSelect,
  onEdgeSelect,
  onMapClick,
  selectedNodeId,
  selectedEdgeId,
  skipInitialFit,
  onInitialFitDone,
  savedCamera,
  onCameraChange,
  pulseLocations,
  participants,
  currentUserId,
  distanceUnit = "km",
  recalculatingEdges,
}: TripMapProps) {
  const defaultCenter = useMemo(() => {
    if (savedCamera) return savedCamera.center;
    if (nodes.length === 0) return { lat: 30, lng: 10 };
    const sorted = [...nodes]
      .filter((n) => n.lat_lng)
      .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0));
    const root = sorted[0];
    if (!root?.lat_lng) return { lat: 30, lng: 10 };
    return { lat: root.lat_lng.lat, lng: root.lat_lng.lng };
  }, [nodes, savedCamera]);

  const defaultZoom = savedCamera?.zoom ?? (nodes.length === 0 ? 2 : 6);

  const nodeMap = useMemo(() => {
    const map = new Map<string, DocumentData>();
    for (const n of nodes) {
      map.set(n.id, n);
    }
    return map;
  }, [nodes]);

  // Root nodes (in-degree 0) — these are starting points of the trip
  const rootNodeIds = useMemo(() => {
    const hasParent = new Set(edges.map((e) => e.to_node_id));
    return new Set(nodes.filter((n) => !hasParent.has(n.id)).map((n) => n.id));
  }, [nodes, edges]);

  const map = useMap();

  // Track zoom changes to recompute pixel distances
  const [zoomTick, setZoomTick] = useState(0);
  // Throttle zoom tick updates to at most once per 80ms to avoid excessive re-renders
  const zoomThrottleRef = useRef<number>(0);

  // Shared padding & fit helpers
  const uiPadding = useMemo(() => {
    const vh = typeof window !== "undefined" ? window.innerHeight : 800;
    return {
      top: Math.min(60, vh * 0.12),    // header + breathing room
      right: 60,                         // path filter toggle
      bottom: Math.min(100, vh * 0.20), // bottom nav + divergence button
      left: 20,
    };
  }, []);

  const fitToNodes = useCallback((targetMap: google.maps.Map, targetNodes: DocumentData[], animate: boolean) => {
    const validNodes = targetNodes.filter((n) => n.lat_lng);

    if (validNodes.length === 0) {
      targetMap.setCenter({ lat: 30, lng: 10 });
      targetMap.setZoom(typeof window !== "undefined" && window.innerWidth < 430 ? 1 : 2);
      return;
    }

    if (validNodes.length === 1) {
      const node = validNodes[0];
      const zoom =
        node.type === "city" ? 11
          : node.type === "hotel" || node.type === "restaurant" || node.type === "activity" ? 14
            : 12;
      if (animate) {
        targetMap.panTo({ lat: node.lat_lng.lat, lng: node.lat_lng.lng });
        targetMap.setZoom(zoom);
      } else {
        targetMap.setCenter({ lat: node.lat_lng.lat, lng: node.lat_lng.lng });
        targetMap.setZoom(zoom);
        targetMap.panBy(0, 20);
      }
      return;
    }

    const bounds = new google.maps.LatLngBounds();
    for (const n of validNodes) {
      bounds.extend({ lat: n.lat_lng.lat, lng: n.lat_lng.lng });
    }
    targetMap.fitBounds(bounds, uiPadding);

    google.maps.event.addListenerOnce(targetMap, "idle", () => {
      const z = targetMap.getZoom() ?? 10;
      if (z > 14) targetMap.setZoom(14);
      if (z < 3) targetMap.setZoom(3);
    });
  }, [uiPadding]);

  // Resolve which nodes to use for initial fit: scope to "my" nodes when in My Path mode
  const initialFitNodes = useMemo(() => {
    if (myNodeIds && myNodeIds.size > 0) {
      return nodes.filter((n) => myNodeIds.has(n.id));
    }
    return nodes;
  }, [nodes, myNodeIds]);

  // Fit map bounds on initial load (skip if returning from settings/agent)
  useEffect(() => {
    if (!map || skipInitialFit) return;
    fitToNodes(map, initialFitNodes, false);
    onInitialFitDone?.();
  }, [map, initialFitNodes, skipInitialFit, onInitialFitDone, fitToNodes]);

  // Re-fit bounds (animated) when user toggles path filter after initial load
  const prevMyNodeIdsRef = useRef<Set<string> | null | undefined>(undefined);
  useEffect(() => {
    // Skip the very first render (initial fit handles it)
    if (prevMyNodeIdsRef.current === undefined) {
      prevMyNodeIdsRef.current = myNodeIds;
      return;
    }
    // Only re-fit if myNodeIds actually changed (user toggled filter)
    if (prevMyNodeIdsRef.current === myNodeIds) return;
    prevMyNodeIdsRef.current = myNodeIds;

    if (!map) return;
    const targetNodes = myNodeIds && myNodeIds.size > 0
      ? nodes.filter((n) => myNodeIds.has(n.id))
      : nodes;
    fitToNodes(map, targetNodes, true);
  }, [myNodeIds, map, nodes, fitToNodes]);

  const placesLib = useMapsLibrary("places");
  const geocodingLib = useMapsLibrary("geocoding");
  const geometryLib = useMapsLibrary("geometry");

  // Decode all edge polylines for click-time proximity detection
  const decodedEdgePaths = useMemo(() => {
    const m = new Map<string, (google.maps.LatLng | { lat: number; lng: number })[]>();
    for (const edge of edges) {
      const from = nodeMap.get(edge.from_node_id);
      const to = nodeMap.get(edge.to_node_id);
      if (!from?.lat_lng || !to?.lat_lng) continue;

      if (edge.route_polyline && edge.travel_mode !== "flight" && geometryLib) {
        try {
          m.set(edge.id, google.maps.geometry.encoding.decodePath(edge.route_polyline));
          continue;
        } catch { /* fall through */ }
      }
      m.set(edge.id, [
        { lat: from.lat_lng.lat, lng: from.lat_lng.lng },
        { lat: to.lat_lng.lat, lng: to.lat_lng.lng },
      ]);
    }
    return m;
  }, [edges, nodeMap, geometryLib]);

  const handleClick = useCallback(
    async (e: MapMouseEvent) => {
      if (!onMapClick || !e.detail.latLng) return;

      const { latLng } = e.detail;
      const placeId = e.detail.placeId;

      // POI click — has placeId, fetch details directly
      if (placeId && placesLib) {
        e.stop();
        try {
          const place = new placesLib.Place({ id: placeId });
          await place.fetchFields({
            fields: ["displayName", "location", "types"],
          });
          const location = place.location;
          if (!location) return;

          onMapClick({
            name: place.displayName ?? "",
            placeId,
            lat: location.lat(),
            lng: location.lng(),
            types: place.types ?? [],
          });
        } catch {
          // Ignore failed place lookups
        }
        return;
      }

      // No placeId (city label, empty area) — reverse geocode
      if (!geocodingLib) return;
      try {
        const geocoder = new geocodingLib.Geocoder();
        const response = await geocoder.geocode({ location: latLng });
        const result = response.results[0];
        if (!result) return;

        const loc = result.geometry.location;
        onMapClick({
          name:
            result.address_components?.find((c) =>
              c.types.includes("locality"),
            )?.long_name ??
            result.address_components?.[0]?.long_name ??
            result.formatted_address ??
            "",
          placeId: result.place_id ?? "",
          lat: loc.lat(),
          lng: loc.lng(),
          types: result.types ?? [],
        });
      } catch {
        // Ignore failed geocoding
      }
    },
    [onMapClick, placesLib, geocodingLib],
  );

  const handleCameraChanged = useCallback(
    (ev: { detail: { center: { lat: number; lng: number }; zoom: number } }) => {
      onCameraChange?.({ center: ev.detail.center, zoom: ev.detail.zoom });
      // Throttle pixel distance recomputation to max once per 80ms
      const now = Date.now();
      if (now - zoomThrottleRef.current > 80) {
        zoomThrottleRef.current = now;
        setZoomTick((t) => t + 1);
      }
    },
    [onCameraChange],
  );

  // Set of dimmed edge IDs — used to exclude them from proximity detection
  const dimmedEdgeIds = useMemo(() => {
    if (!myEdgeKeys) return new Set<string>();
    const dimmed = new Set<string>();
    for (const edge of edges) {
      const edgeKey = `${edge.from_node_id}->${edge.to_node_id}`;
      if (!myEdgeKeys.has(edgeKey)) dimmed.add(edge.id);
    }
    return dimmed;
  }, [edges, myEdgeKeys]);

  // Memoized per-edge click handlers — stable references prevent polyline re-mounts
  // when unrelated state changes (e.g. selectedEdgeId) trigger a parent re-render.
  // Also performs click-time proximity detection for overlapping edges.
  const edgeClickHandlers = useMemo(() => {
    const m = new Map<string, (clickLatLng?: { lat: number; lng: number }) => void>();
    for (const edge of edges) {
      m.set(edge.id, (clickLatLng) => {
        if (!onEdgeSelect) return;

        // No click coords or no geometry lib — skip proximity check
        if (!clickLatLng || !geometryLib) {
          onEdgeSelect(edge.id);
          return;
        }

        // Find all non-dimmed edges whose polyline passes near the click point
        const clickPoint = new google.maps.LatLng(clickLatLng.lat, clickLatLng.lng);
        const nearby: string[] = [];
        for (const [otherId, path] of decodedEdgePaths) {
          if (otherId === edge.id) continue;
          if (dimmedEdgeIds.has(otherId)) continue;
          const polyPath = path.map(p =>
            p instanceof google.maps.LatLng ? p : new google.maps.LatLng(p.lat, p.lng),
          );
          // tolerance ~0.0005 degrees ≈ ~50m, reasonable for shared road detection
          if (google.maps.geometry.poly.isLocationOnEdge(
            clickPoint,
            new google.maps.Polyline({ path: polyPath }),
            0.0005,
          )) {
            nearby.push(otherId);
          }
        }

        onEdgeSelect(edge.id, nearby.length > 0 ? nearby : undefined);
      });
    }
    return m;
  }, [edges, onEdgeSelect, decodedEdgePaths, geometryLib, dimmedEdgeIds]);

  // Memoized per-node click handlers — same rationale as edgeClickHandlers.
  const nodeClickHandlers = useMemo(() => {
    const m = new Map<string, (nodeId: string) => void>();
    for (const node of nodes) {
      m.set(node.id, (nodeId: string) => onNodeSelect?.(nodeId));
    }
    return m;
  }, [nodes, onNodeSelect]);

  // Compute pixel distances for each edge (between its from/to nodes)
  // zoomTick is included in deps to recompute when the user zooms/pans.
  const edgePixelDistances = useMemo(() => {
    if (!map || zoomTick < 0) return new Map<string, number>();
    const distances = new Map<string, number>();
    for (const edge of edges) {
      const from = nodeMap.get(edge.from_node_id);
      const to = nodeMap.get(edge.to_node_id);
      if (!from?.lat_lng || !to?.lat_lng) continue;
      const px = getPixelDistance(map, from.lat_lng, to.lat_lng);
      distances.set(edge.id, px);
    }
    return distances;
  }, [map, edges, nodeMap, zoomTick]);

  // Compute proximity scale for each node based on minimum pixel distance to any neighbor
  const nodeProximityScales = useMemo(() => {
    if (!map || zoomTick < 0) return new Map<string, number>();

    // Build adjacency: for each node, find its nearest neighbor pixel distance
    const minDistances = new Map<string, number>();
    for (const edge of edges) {
      const dist = edgePixelDistances.get(edge.id) ?? Infinity;
      const curFrom = minDistances.get(edge.from_node_id) ?? Infinity;
      const curTo = minDistances.get(edge.to_node_id) ?? Infinity;
      minDistances.set(edge.from_node_id, Math.min(curFrom, dist));
      minDistances.set(edge.to_node_id, Math.min(curTo, dist));
    }

    const scales = new Map<string, number>();
    for (const [nodeId, minDist] of minDistances) {
      if (minDist >= MIN_PX_PROXIMITY) {
        scales.set(nodeId, 1);
      } else if (minDist <= COMPACT_PX_THRESHOLD) {
        scales.set(nodeId, MIN_SCALE);
      } else {
        // Linear interpolation between MIN_SCALE and 1
        const t = (minDist - COMPACT_PX_THRESHOLD) / (MIN_PX_PROXIMITY - COMPACT_PX_THRESHOLD);
        scales.set(nodeId, MIN_SCALE + t * (1 - MIN_SCALE));
      }
    }
    return scales;
  }, [map, edges, edgePixelDistances, zoomTick]);

  // Compute fan-out offsets for co-located nodes (< FAN_OUT_THRESHOLD px apart).
  // Groups overlapping nodes and spreads them in a radial pattern with bounded drift.
  // Returns a Map of nodeId -> { lat, lng, realLat, realLng } for displaced nodes.
  const nodeFanOutPositions = useMemo(() => {
    const positions = new Map<string, { lat: number; lng: number; realLat: number; realLng: number }>();
    if (!map || zoomTick < 0) return positions;

    const projection = map.getProjection();
    const zoom = map.getZoom();
    if (!projection || zoom == null) return positions;
    const scale = Math.pow(2, zoom);

    // Build a list of nodes with valid positions and their pixel coords
    const nodePixels: { id: string; lat: number; lng: number; px: number; py: number }[] = [];
    for (const node of nodes) {
      if (!node.lat_lng) continue;
      const p = projection.fromLatLngToPoint(
        new google.maps.LatLng(node.lat_lng.lat, node.lat_lng.lng),
      );
      if (!p) continue;
      nodePixels.push({
        id: node.id,
        lat: node.lat_lng.lat,
        lng: node.lat_lng.lng,
        px: p.x * scale,
        py: p.y * scale,
      });
    }

    // Union-find clustering for nodes within FAN_OUT_THRESHOLD
    const parent = new Map<string, string>();
    function find(id: string): string {
      let root = id;
      while (parent.get(root) !== root) root = parent.get(root)!;
      let curr = id;
      while (curr !== root) {
        const next = parent.get(curr)!;
        parent.set(curr, root);
        curr = next;
      }
      return root;
    }
    function union(a: string, b: string) {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(rb, ra);
    }

    for (const np of nodePixels) parent.set(np.id, np.id);

    for (let i = 0; i < nodePixels.length; i++) {
      for (let j = i + 1; j < nodePixels.length; j++) {
        const dx = nodePixels[i].px - nodePixels[j].px;
        const dy = nodePixels[i].py - nodePixels[j].py;
        if (Math.sqrt(dx * dx + dy * dy) < FAN_OUT_THRESHOLD) {
          union(nodePixels[i].id, nodePixels[j].id);
        }
      }
    }

    // Group by cluster root
    const clusters = new Map<string, typeof nodePixels>();
    for (const np of nodePixels) {
      const root = find(np.id);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root)!.push(np);
    }

    // All final pixel positions (singletons stay at their original spot)
    const finalPixels = new Map<string, { px: number; py: number }>();
    for (const np of nodePixels) {
      const cluster = clusters.get(find(np.id));
      if (cluster && cluster.length < 2) finalPixels.set(np.id, { px: np.px, py: np.py });
    }

    // For clusters with 2+ members: fan out with bounded drift from each node's real position.
    // Displacement is anchored to each node's own position (not the centroid), capped at MAX_DRIFT_PX.
    for (const members of clusters.values()) {
      if (members.length < 2) continue;

      // Centroid for computing preferred direction
      let cx = 0, cy = 0;
      for (const m of members) { cx += m.px; cy += m.py; }
      cx /= members.length;
      cy /= members.length;

      // Sort members by distance from centroid (furthest first — they have the most natural separation)
      const sorted = [...members].sort((a, b) => {
        const da = (a.px - cx) ** 2 + (a.py - cy) ** 2;
        const db = (b.px - cx) ** 2 + (b.py - cy) ** 2;
        return db - da;
      });

      const tooClose = (px: number, py: number, excludeId?: string) => {
        for (const [id, fp] of finalPixels) {
          if (id === excludeId) continue;
          const ddx = fp.px - px, ddy = fp.py - py;
          if (Math.sqrt(ddx * ddx + ddy * ddy) < MIN_SEPARATION) return true;
        }
        return false;
      };

      for (const member of sorted) {
        // Preferred direction: away from centroid (toward real geographic position)
        const dx = member.px - cx;
        const dy = member.py - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const preferredAngle = dist > 0.5
          ? Math.atan2(dy, dx)
          : (2 * Math.PI * sorted.indexOf(member)) / sorted.length - Math.PI / 2;

        // Try the preferred angle at increasing radii, then rotate.
        // All candidate positions are bounded by MAX_DRIFT_PX from the node's own position.
        let bestPx = member.px;
        let bestPy = member.py;
        let bestScore = Infinity; // lower = better (overlap count)

        const tryCandidate = (px: number, py: number) => {
          // Check drift from own real position
          const drift = Math.sqrt((px - member.px) ** 2 + (py - member.py) ** 2);
          if (drift > MAX_DRIFT_PX) return;

          if (!tooClose(px, py, member.id)) {
            // No collision — take it immediately
            bestPx = px;
            bestPy = py;
            bestScore = -1;
            return true;
          }

          // Count overlaps for "least bad" fallback
          let overlaps = 0;
          for (const [id, fp] of finalPixels) {
            if (id === member.id) continue;
            const ddx = fp.px - px, ddy = fp.py - py;
            if (Math.sqrt(ddx * ddx + ddy * ddy) < MIN_SEPARATION) overlaps++;
          }
          if (overlaps < bestScore) {
            bestScore = overlaps;
            bestPx = px;
            bestPy = py;
          }
          return false;
        };

        // Try radii from FAN_OUT_RADIUS up to MAX_DRIFT_PX, in steps
        let found = false;
        for (let r = FAN_OUT_RADIUS; r <= MAX_DRIFT_PX && !found; r += 8) {
          // Try 24 angle steps (15° each), alternating left/right from preferred
          for (let step = 0; step < 24 && !found; step++) {
            const sign = step % 2 === 0 ? 1 : -1;
            const offset = Math.ceil(step / 2) * (Math.PI / 12);
            const angle = preferredAngle + sign * offset;
            const testPx = member.px + r * Math.cos(angle);
            const testPy = member.py + r * Math.sin(angle);
            if (tryCandidate(testPx, testPy)) { found = true; }
          }
        }

        finalPixels.set(member.id, { px: bestPx, py: bestPy });

        // Only record if actually displaced
        const totalDrift = Math.sqrt((bestPx - member.px) ** 2 + (bestPy - member.py) ** 2);
        if (totalDrift > 2) {
          const point = new google.maps.Point(bestPx / scale, bestPy / scale);
          const latLng = projection.fromPointToLatLng(point);
          if (latLng) {
            positions.set(member.id, {
              lat: latLng.lat(),
              lng: latLng.lng(),
              realLat: member.lat,
              realLng: member.lng,
            });
          }
        }
      }
    }

    return positions;
  }, [map, nodes, zoomTick]);

  return (
    <GoogleMap
      defaultCenter={defaultCenter}
      defaultZoom={defaultZoom}
      mapId="trip-map"
      className="w-full h-full"
      gestureHandling="greedy"
      disableDefaultUI={false}
      zoomControl
      mapTypeControl={false}
      streetViewControl={false}
      fullscreenControl={false}
      onClick={handleClick}
      onCameraChanged={handleCameraChanged}
    >
      {edges.map((edge) => {
        const from = nodeMap.get(edge.from_node_id);
        const to = nodeMap.get(edge.to_node_id);
        if (!from?.lat_lng || !to?.lat_lng) return null;
        const edgeKey = `${edge.from_node_id}->${edge.to_node_id}`;
        const dimmed = myEdgeKeys ? !myEdgeKeys.has(edgeKey) : false;

        // Timing warning: source departure + travel time > destination arrival
        let timingWarning = false;
        const depTime = from.departure_time ?? from.arrival_time;
        const arrTime = to.arrival_time;
        if (depTime && arrTime && edge.travel_time_hours > 0) {
          const depMs = new Date(depTime).getTime();
          const arrMs = new Date(arrTime).getTime();
          const travelMs = edge.travel_time_hours * 3_600_000;
          timingWarning = arrMs < depMs + travelMs;
        }

        return (
          <EdgePolyline
            key={edge.id}
            fromLat={from.lat_lng.lat}
            fromLng={from.lat_lng.lng}
            toLat={to.lat_lng.lat}
            toLng={to.lat_lng.lng}
            travelMode={edge.travel_mode}
            travelTimeHours={edge.travel_time_hours}
            distanceKm={edge.distance_km}
            distanceUnit={distanceUnit}
            routePolyline={edge.route_polyline}
            selected={selectedEdgeId === edge.id}
            pathColor={dimmed ? undefined : edgeColors?.get(edgeKey)}
            dimmed={dimmed}
            timingWarning={timingWarning}
            recalculating={recalculatingEdges?.has(edge.id)}
            pixelDistance={edgePixelDistances.get(edge.id)}
            fromNodeName={from.name}
            toNodeName={to.name}
            onClick={edgeClickHandlers.get(edge.id)}
          />
        );
      })}

      {/* Tether lines + anchor dots for fanned-out nodes */}
      {nodes.map((node) => {
        const fanOut = nodeFanOutPositions.get(node.id);
        if (!fanOut) return null;
        const color = (TYPE_TOKENS[node.type] ?? FALLBACK_TOKEN).bg;
        return (
          <FanOutTether
            key={`tether-${node.id}`}
            realLat={fanOut.realLat}
            realLng={fanOut.realLng}
            displayLat={fanOut.lat}
            displayLng={fanOut.lng}
            color={color}
          />
        );
      })}

      {nodes.map((node) => {
        const dimmed = myNodeIds ? !myNodeIds.has(node.id) : false;
        const fanOut = nodeFanOutPositions.get(node.id);
        return (
          <NodeMarker
            key={node.id}
            id={node.id}
            name={node.name}
            type={node.type}
            lat={fanOut?.lat ?? node.lat_lng?.lat ?? 0}
            lng={fanOut?.lng ?? node.lat_lng?.lng ?? 0}
            arrivalTime={node.arrival_time}
            selected={selectedNodeId === node.id}
            isMergeNode={mergeNodeIds?.has(node.id)}
            isStartNode={rootNodeIds.has(node.id)}
            dimmed={dimmed}
            proximityScale={nodeProximityScales.get(node.id) ?? 1}
            fannedOut={nodeFanOutPositions.has(node.id)}
            onClick={nodeClickHandlers.get(node.id)}
          />
        );
      })}

      {pulseLocations && participants && currentUserId && (
        <PulseAvatars
          locations={pulseLocations}
          participants={participants}
          currentUserId={currentUserId}
        />
      )}
    </GoogleMap>
  );
}
