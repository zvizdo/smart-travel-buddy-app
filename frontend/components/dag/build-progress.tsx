"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/** Color tokens matching NodeMarker TYPE_TOKENS */
const TYPE_COLORS: Record<string, string> = {
  city: "#006479",
  hotel: "#5e35b1",
  restaurant: "#6d5a00",
  place: "#006b1b",
  activity: "#b31b25",
};
const FALLBACK_COLOR = "#707978";

type BuildPhase = "preparing" | "nodes" | "edges" | "verifying" | "complete";

export interface BuildAction {
  type: string; // node_added, edge_added, etc.
  node_id?: string | null;
  description: string;
}

interface GraphNode {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  animatedAt: number;
}

interface GraphEdge {
  fromId: string;
  toId: string;
  animatedAt: number;
}

interface BuildProgressProps {
  actions: BuildAction[];
  phase: BuildPhase;
  error?: string | null;
  onRetry?: () => void;
}

/** Compute layout positions for nodes in a flowing horizontal arrangement */
function layoutNodes(nodes: GraphNode[]): GraphNode[] {
  if (nodes.length === 0) return [];
  const PADDING_X = 100;
  const PADDING_Y = 60;
  const COLS = Math.min(nodes.length, 4);
  const spacingX = (600 - 2 * PADDING_X) / Math.max(COLS - 1, 1);
  const rows = Math.ceil(nodes.length / COLS);
  const spacingY = (300 - 2 * PADDING_Y) / Math.max(rows - 1, 1);

  return nodes.map((node, i) => ({
    ...node,
    x: PADDING_X + (i % COLS) * spacingX,
    y: PADDING_Y + Math.floor(i / COLS) * spacingY,
  }));
}

function PhaseIndicator({ phase }: { phase: BuildPhase }) {
  const phases: { key: BuildPhase; label: string }[] = [
    { key: "nodes", label: "Creating stops" },
    { key: "edges", label: "Planning routes" },
    { key: "verifying", label: "Verifying" },
    { key: "complete", label: "Done" },
  ];

  const currentIdx = phases.findIndex((p) => p.key === phase);

  return (
    <div className="flex items-center gap-2">
      {phases.map((p, i) => {
        const isActive = p.key === phase;
        const isDone = i < currentIdx;
        return (
          <div key={p.key} className="flex items-center gap-2">
            {i > 0 && (
              <div
                className={`h-px w-4 transition-colors duration-500 ${
                  isDone ? "bg-primary" : "bg-outline/30"
                }`}
              />
            )}
            <div
              className={`h-2 w-2 rounded-full transition-all duration-500 ${
                isActive
                  ? "bg-primary scale-125 animate-pulse"
                  : isDone
                    ? "bg-primary"
                    : "bg-outline/30"
              }`}
            />
          </div>
        );
      })}
    </div>
  );
}

function ActivityFeed({ actions }: { actions: BuildAction[] }) {
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [actions.length]);

  return (
    <div
      ref={feedRef}
      className="max-h-40 overflow-y-auto space-y-1.5 scrollbar-thin"
    >
      {actions.map((action, i) => (
        <div
          key={i}
          className="flex items-center gap-2 text-xs"
          style={{
            animation: "fadeSlideUp 0.3s ease-out both",
            animationDelay: `${i * 30}ms`,
          }}
        >
          <span className="text-primary flex-shrink-0">
            {action.type.includes("added") ? (
              <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none">
                <path
                  d="M2 6l3 3 5-5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none">
                <circle
                  cx="6"
                  cy="6"
                  r="4"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              </svg>
            )}
          </span>
          <span className="text-on-surface-variant truncate">
            {action.description}
          </span>
        </div>
      ))}
      {actions.length === 0 && (
        <p className="text-xs text-outline italic">
          Analyzing your trip plan...
        </p>
      )}
    </div>
  );
}

function GraphCanvas({
  nodes,
  edges,
  phase,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  phase: BuildPhase;
}) {
  const laidOut = useMemo(() => layoutNodes(nodes), [nodes]);
  const nodeMap = useMemo(() => {
    const m = new Map<string, GraphNode>();
    laidOut.forEach((n) => m.set(n.id, n));
    return m;
  }, [laidOut]);

  return (
    <svg viewBox="0 0 600 300" className="w-full h-full" fill="none">
      {/* Background grid dots */}
      <defs>
        <pattern id="grid" width="30" height="30" patternUnits="userSpaceOnUse">
          <circle cx="15" cy="15" r="0.8" fill="currentColor" opacity="0.08" />
        </pattern>
      </defs>
      <rect width="600" height="300" fill="url(#grid)" />

      {/* Edges */}
      {edges.map((edge, i) => {
        const from = nodeMap.get(edge.fromId);
        const to = nodeMap.get(edge.toId);
        if (!from || !to) return null;

        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const len = Math.sqrt(dx * dx + dy * dy);

        return (
          <g key={`edge-${i}`}>
            <line
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke="var(--color-primary, #006479)"
              strokeWidth="2"
              strokeLinecap="round"
              opacity="0.5"
              strokeDasharray={len}
              strokeDashoffset={len}
            >
              <animate
                attributeName="stroke-dashoffset"
                from={len}
                to="0"
                dur="0.6s"
                fill="freeze"
                begin="0s"
              />
            </line>
            {/* Travel arrow at midpoint */}
            <circle
              cx={(from.x + to.x) / 2}
              cy={(from.y + to.y) / 2}
              r="3"
              fill="var(--color-primary, #006479)"
              opacity="0"
            >
              <animate
                attributeName="opacity"
                from="0"
                to="0.6"
                dur="0.3s"
                fill="freeze"
                begin="0.5s"
              />
            </circle>
          </g>
        );
      })}

      {/* Nodes */}
      {laidOut.map((node) => {
        const color = TYPE_COLORS[node.type] ?? FALLBACK_COLOR;
        return (
          <g key={node.id}>
            {/* Glow ring */}
            <circle
              cx={node.x}
              cy={node.y}
              r="22"
              fill="none"
              stroke={color}
              strokeWidth="1"
              opacity="0"
            >
              <animate
                attributeName="opacity"
                values="0;0.3;0"
                dur="2s"
                repeatCount="1"
                begin="0.2s"
              />
              <animate
                attributeName="r"
                values="16;24;22"
                dur="0.5s"
                fill="freeze"
              />
            </circle>
            {/* Node circle */}
            <circle
              cx={node.x}
              cy={node.y}
              r="0"
              fill={color}
              stroke="#fff"
              strokeWidth="2"
            >
              <animate
                attributeName="r"
                from="0"
                to="14"
                dur="0.4s"
                fill="freeze"
                calcMode="spline"
                keySplines="0.34 1.56 0.64 1"
                keyTimes="0;1"
              />
            </circle>
            {/* Node label */}
            <text
              x={node.x}
              y={node.y + 28}
              textAnchor="middle"
              fill="currentColor"
              fontSize="10"
              fontWeight="500"
              opacity="0"
              className="text-on-surface"
            >
              <animate
                attributeName="opacity"
                from="0"
                to="0.8"
                dur="0.3s"
                fill="freeze"
                begin="0.3s"
              />
              {node.name.length > 14
                ? node.name.slice(0, 12) + "..."
                : node.name}
            </text>
          </g>
        );
      })}

      {/* Verification sweep */}
      {phase === "verifying" && (
        <rect x="-100" y="0" width="100" height="300" opacity="0.08">
          <animate
            attributeName="x"
            from="-100"
            to="700"
            dur="1.5s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="fill"
            values="var(--color-primary, #006479);var(--color-primary, #006479)"
            dur="1.5s"
          />
        </rect>
      )}

      {/* Completion pulse */}
      {phase === "complete" &&
        laidOut.map((node) => {
          const color = TYPE_COLORS[node.type] ?? FALLBACK_COLOR;
          return (
            <circle
              key={`pulse-${node.id}`}
              cx={node.x}
              cy={node.y}
              r="14"
              fill="none"
              stroke={color}
              strokeWidth="2"
              opacity="0"
            >
              <animate
                attributeName="r"
                values="14;22;14"
                dur="0.6s"
                fill="freeze"
              />
              <animate
                attributeName="opacity"
                values="0;0.5;0"
                dur="0.6s"
                fill="freeze"
              />
            </circle>
          );
        })}
    </svg>
  );
}

const KEYFRAMES_CSS = `
@keyframes fadeSlideUp {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
`;

export function BuildProgress({
  actions,
  phase,
  error,
  onRetry,
}: BuildProgressProps) {
  const [graphNodes, setGraphNodes] = useState<GraphNode[]>([]);
  const [graphEdges, setGraphEdges] = useState<GraphEdge[]>([]);

  // Parse actions into graph nodes and edges for visualization
  useEffect(() => {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const nodeIds = new Set<string>();

    for (const action of actions) {
      if (action.type === "node_added" && action.node_id) {
        if (nodeIds.has(action.node_id)) continue;
        nodeIds.add(action.node_id);
        // Extract name from description like "Added stop: Paris"
        const name = action.description.replace(/^Added stop:\s*/, "");
        // Guess type from description context — default to city
        nodes.push({
          id: action.node_id,
          name,
          type: "city",
          x: 0,
          y: 0,
          animatedAt: Date.now(),
        });
      } else if (action.type === "edge_added") {
        // Extract from/to from description like "Connected Paris to Barcelona"
        const match = action.description.match(
          /^Connected\s+(.+?)\s+to\s+(.+)$/,
        );
        if (match) {
          // Find node IDs by name
          const fromNode = nodes.find((n) => n.name === match[1]);
          const toNode = nodes.find((n) => n.name === match[2]);
          if (fromNode && toNode) {
            edges.push({
              fromId: fromNode.id,
              toId: toNode.id,
              animatedAt: Date.now(),
            });
          }
        }
      }
    }

    setGraphNodes(nodes);
    setGraphEdges(edges);
  }, [actions]);

  const phaseLabel =
    phase === "preparing"
      ? "Analyzing your trip plan..."
      : phase === "nodes"
        ? "Creating stops..."
        : phase === "edges"
          ? "Planning routes..."
          : phase === "verifying"
            ? "Verifying plan..."
            : "Your trip is ready!";

  return (
    <div className="flex flex-col items-center flex-1 bg-surface px-5 py-8">
      {/* eslint-disable-next-line react/no-danger */}
      <style dangerouslySetInnerHTML={{ __html: KEYFRAMES_CSS }} />
      {/* Header */}
      <div className="text-center mb-6">
        <div className="w-12 h-12 rounded-2xl gradient-primary flex items-center justify-center mx-auto mb-4 shadow-ambient">
          {phase === "complete" ? (
            <svg
              className="h-6 w-6 text-on-primary"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4.5 12.75l6 6 9-13.5"
              />
            </svg>
          ) : (
            <svg
              className="h-6 w-6 text-on-primary animate-pulse"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z"
              />
            </svg>
          )}
        </div>
        <h2 className="text-lg font-bold text-on-surface mb-1">{phaseLabel}</h2>
        <PhaseIndicator phase={phase} />
      </div>

      {/* Graph Canvas */}
      <div className="w-full max-w-lg aspect-[2/1] rounded-2xl bg-surface-lowest border border-outline/10 overflow-hidden mb-6">
        {graphNodes.length > 0 ? (
          <GraphCanvas nodes={graphNodes} edges={graphEdges} phase={phase} />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <div className="flex items-center gap-3">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-surface-high border-t-primary" />
              <p className="text-sm text-on-surface-variant">
                Reading your conversation...
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Activity Feed */}
      <div className="w-full max-w-lg rounded-2xl bg-surface-lowest border border-outline/10 p-4">
        <p className="text-xs font-medium text-on-surface-variant mb-2 uppercase tracking-wider">
          Activity
        </p>
        <ActivityFeed actions={actions} />
      </div>

      {/* Stats */}
      {(graphNodes.length > 0 || graphEdges.length > 0) && (
        <div className="flex gap-6 mt-4">
          <div className="text-center">
            <p className="text-xl font-bold text-on-surface">
              {graphNodes.length}
            </p>
            <p className="text-xs text-on-surface-variant">stops</p>
          </div>
          <div className="text-center">
            <p className="text-xl font-bold text-on-surface">
              {graphEdges.length}
            </p>
            <p className="text-xs text-on-surface-variant">routes</p>
          </div>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="w-full max-w-lg mt-6 rounded-2xl bg-error-container/15 p-4 text-center">
          <p className="text-sm text-error mb-3">{error}</p>
          {onRetry && (
            <button
              onClick={onRetry}
              className="rounded-2xl bg-error px-6 py-2.5 text-sm font-semibold text-on-error transition-all active:scale-[0.98]"
            >
              Try Again
            </button>
          )}
        </div>
      )}
    </div>
  );
}
