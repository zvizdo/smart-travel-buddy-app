/**
 * Client-side participant path computation.
 * Mirrors the shared library logic for real-time coloring without backend calls.
 */

interface NodeData {
  id: string;
  participant_ids?: string[] | null;
  [key: string]: unknown;
}

interface EdgeData {
  from_node_id: string;
  to_node_id: string;
  [key: string]: unknown;
}

export interface PathResult {
  paths: Map<string, string[]>;
  unresolved: { user_id: string; divergence_node_id: string }[];
}

const PATH_COLORS = [
  "#FF5733",
  "#3498DB",
  "#2ECC71",
  "#9B59B6",
  "#F39C12",
  "#1ABC9C",
  "#E74C3C",
  "#E67E22",
  "#1F77B4",
  "#8B4513",
];

export function getPathColor(index: number): string {
  return PATH_COLORS[index % PATH_COLORS.length];
}

function buildAdjacency(edges: EdgeData[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const children = adj.get(e.from_node_id) ?? [];
    children.push(e.to_node_id);
    adj.set(e.from_node_id, children);
  }
  return adj;
}

function buildReverseAdj(edges: EdgeData[]): Set<string> {
  const hasParent = new Set<string>();
  for (const e of edges) {
    hasParent.add(e.to_node_id);
  }
  return hasParent;
}

function findRoots(nodes: NodeData[], hasParent: Set<string>): string[] {
  return nodes.filter((n) => !hasParent.has(n.id)).map((n) => n.id);
}

export function computeParticipantPaths(
  nodes: NodeData[],
  edges: EdgeData[],
  participantIds: string[],
): PathResult {
  const adj = buildAdjacency(edges);
  const hasParent = buildReverseAdj(edges);
  const roots = findRoots(nodes, hasParent);
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  const paths = new Map<string, string[]>();
  const unresolved: { user_id: string; divergence_node_id: string }[] = [];

  for (const uid of participantIds) {
    const startNodes = findStartForParticipant(uid, roots, nodeMap);

    // Detect unresolved multi-root divergence
    if (roots.length > 1) {
      const assignedRoots: string[] = [];
      const unassignedRoots: string[] = [];
      for (const rootId of roots) {
        const node = nodeMap.get(rootId);
        if (!node) continue;
        const pids = node.participant_ids;
        if (pids && pids.length > 0) {
          assignedRoots.push(rootId);
        } else {
          unassignedRoots.push(rootId);
        }
      }
      if (assignedRoots.length === 0) {
        unresolved.push({ user_id: uid, divergence_node_id: "__root__" });
      } else {
        const assigned = assignedRoots.some((rid) => {
          const n = nodeMap.get(rid);
          return n?.participant_ids?.includes(uid);
        });
        if (!assigned && unassignedRoots.length === 0) {
          unresolved.push({ user_id: uid, divergence_node_id: "__root__" });
        }
      }
    }

    const path: string[] = [];
    const visited = new Set<string>();
    const queue = [...startNodes];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      if (visited.has(currentId)) continue;
      visited.add(currentId);
      path.push(currentId);

      const children = adj.get(currentId) ?? [];
      if (children.length === 0) continue;
      if (children.length === 1) {
        queue.push(children[0]);
        continue;
      }

      // Check if any child at this divergence has participant assignments
      const assignedChildren: string[] = [];
      const unassignedChildren: string[] = [];
      for (const childId of children) {
        const child = nodeMap.get(childId);
        if (!child) continue;
        const pids = child.participant_ids;
        if (pids && pids.length > 0) {
          assignedChildren.push(childId);
        } else {
          unassignedChildren.push(childId);
        }
      }

      if (assignedChildren.length === 0) {
        // No assignments at this divergence — can't decide where to flow
        unresolved.push({
          user_id: uid,
          divergence_node_id: currentId,
        });
      } else {
        // Some branches have assignments — follow the right one
        let resolved = false;
        for (const childId of assignedChildren) {
          const child = nodeMap.get(childId)!;
          if (child.participant_ids!.includes(uid)) {
            queue.push(childId);
            resolved = true;
          }
        }
        // If not explicitly assigned, follow unassigned (shared) branches
        if (!resolved && unassignedChildren.length > 0) {
          for (const childId of unassignedChildren) {
            queue.push(childId);
          }
          resolved = true;
        }
        if (!resolved) {
          unresolved.push({
            user_id: uid,
            divergence_node_id: currentId,
          });
        }
      }
    }

    paths.set(uid, path);
  }

  return { paths, unresolved };
}

function findStartForParticipant(
  uid: string,
  roots: string[],
  nodeMap: Map<string, NodeData>,
): string[] {
  if (roots.length <= 1) return roots;

  const assigned: string[] = [];
  const unassigned: string[] = [];

  for (const rootId of roots) {
    const node = nodeMap.get(rootId);
    if (!node) continue;
    const pids = node.participant_ids;
    if (!pids || pids.length === 0) {
      unassigned.push(rootId);
    } else if (pids.includes(uid)) {
      assigned.push(rootId);
    }
  }

  if (assigned.length > 0) return assigned;
  if (unassigned.length > 0) return [unassigned[0]];
  return [roots[0]];
}

/**
 * Compute edge colors based on participant paths.
 * Returns a map of edge key ("from->to") to color string.
 */
export function computeEdgeColors(
  edges: EdgeData[],
  paths: Map<string, string[]>,
  participantIds: string[],
): Map<string, string> {
  const edgeColors = new Map<string, string>();

  for (let i = 0; i < participantIds.length; i++) {
    const uid = participantIds[i];
    const path = paths.get(uid);
    if (!path) continue;
    const color = getPathColor(i);

    for (let j = 0; j < path.length - 1; j++) {
      const key = `${path[j]}->${path[j + 1]}`;
      if (!edgeColors.has(key)) {
        edgeColors.set(key, color);
      }
    }
  }

  return edgeColors;
}
