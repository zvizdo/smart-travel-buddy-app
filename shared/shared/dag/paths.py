"""Participant path computation for implicit branching.

Paths are derived at runtime from DAG topology (edges) and participant_ids on nodes.
No explicit branch entity is stored.
"""

from collections import defaultdict, deque
from dataclasses import dataclass, field


@dataclass
class PathResult:
    """Result of path computation for all participants."""

    paths: dict[str, list[str]]  # user_id -> ordered list of node_ids
    unresolved: list[dict]  # warnings for participants without assignments


@dataclass
class DivergencePoint:
    """A node with out-degree > 1 where the DAG splits."""

    node_id: str
    child_node_ids: list[str] = field(default_factory=list)


@dataclass
class MergeNode:
    """A node with in-degree > 1 from different computed paths."""

    node_id: str
    incoming_path_groups: list[list[str]] = field(default_factory=list)


def build_adjacency(
    edges: list[dict],
) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    """Build forward and reverse adjacency lists from edges.

    Returns (forward_adj, reverse_adj) where each maps node_id to list of connected node_ids.
    """
    forward: dict[str, list[str]] = defaultdict(list)
    reverse: dict[str, list[str]] = defaultdict(list)
    for e in edges:
        forward[e["from_node_id"]].append(e["to_node_id"])
        reverse[e["to_node_id"]].append(e["from_node_id"])
    return dict(forward), dict(reverse)


def find_root_nodes(
    nodes: list[dict], reverse_adj: dict[str, list[str]]
) -> list[str]:
    """Find root nodes (in-degree = 0)."""
    return [n["id"] for n in nodes if n["id"] not in reverse_adj]


def compute_participant_paths(
    nodes: list[dict],
    edges: list[dict],
    participant_ids: list[str],
) -> PathResult:
    """Compute each participant's path through the DAG.

    Algorithm:
    1. Build adjacency list from edges.
    2. Identify root nodes (in-degree = 0).
    3. For each participant, BFS/DFS downstream:
       - At divergence points (out-degree > 1), follow the child where the participant
         is in participant_ids. If not assigned, record an unresolved warning.
       - At shared segments (participant_ids is null/empty), continue normally.
    4. Return Map<userId, List<nodeId>> and unresolved warnings.
    """
    forward_adj, reverse_adj = build_adjacency(edges)
    roots = find_root_nodes(nodes, reverse_adj)
    node_map: dict[str, dict] = {n["id"]: n for n in nodes}

    paths: dict[str, list[str]] = {}
    unresolved: list[dict] = []

    for uid in participant_ids:
        start_nodes = _find_start_for_participant(uid, roots, node_map)
        if not start_nodes:
            if roots:
                start_nodes = roots[:1]
            else:
                paths[uid] = []
                continue

        # Detect unresolved multi-root divergence
        if len(roots) > 1:
            assigned_roots = []
            unassigned_roots = []
            for root_id in roots:
                node = node_map.get(root_id)
                if node is None:
                    continue
                pids = node.get("participant_ids")
                if pids and len(pids) > 0:
                    assigned_roots.append(root_id)
                else:
                    unassigned_roots.append(root_id)
            if not assigned_roots:
                unresolved.append({
                    "user_id": uid,
                    "divergence_node_id": "__root__",
                    "message": "No participants assigned at starting points",
                })
            elif not any(
                uid in (node_map.get(rid, {}).get("participant_ids") or [])
                for rid in assigned_roots
            ) and not unassigned_roots:
                unresolved.append({
                    "user_id": uid,
                    "divergence_node_id": "__root__",
                    "message": "Participant not assigned at starting points",
                })

        path: list[str] = []
        visited: set[str] = set()
        queue: deque[str] = deque(start_nodes)

        while queue:
            current_id = queue.popleft()
            if current_id in visited:
                continue
            visited.add(current_id)
            path.append(current_id)

            children = forward_adj.get(current_id, [])
            if len(children) == 0:
                continue
            elif len(children) == 1:
                queue.append(children[0])
            else:
                # Check if any child at this divergence has participant assignments
                assigned_children = []
                unassigned_children = []
                for child_id in children:
                    child_node = node_map.get(child_id)
                    if child_node is None:
                        continue
                    child_pids = child_node.get("participant_ids")
                    if child_pids and len(child_pids) > 0:
                        assigned_children.append(child_id)
                    else:
                        unassigned_children.append(child_id)

                if not assigned_children:
                    # No assignments at this divergence — can't decide where to flow
                    unresolved.append({
                        "user_id": uid,
                        "divergence_node_id": current_id,
                        "message": "No participants assigned at divergence point",
                    })
                else:
                    resolved = False
                    for child_id in assigned_children:
                        child_node = node_map[child_id]
                        if uid in child_node.get("participant_ids", []):
                            queue.append(child_id)
                            resolved = True
                    # If not explicitly assigned, follow unassigned (shared) branches
                    if not resolved and unassigned_children:
                        for child_id in unassigned_children:
                            queue.append(child_id)
                        resolved = True
                    if not resolved:
                        unresolved.append({
                            "user_id": uid,
                            "divergence_node_id": current_id,
                            "message": "Participant not assigned at divergence point",
                        })

        paths[uid] = path

    return PathResult(paths=paths, unresolved=unresolved)


def _find_start_for_participant(
    uid: str, roots: list[str], node_map: dict[str, dict]
) -> list[str]:
    """Find the root node(s) for a participant.

    If there's a single root, start there.
    If multiple roots, find the one where participant is in participant_ids.
    """
    if len(roots) <= 1:
        return roots

    assigned_roots = []
    unassigned_roots = []
    for root_id in roots:
        node = node_map.get(root_id)
        if node is None:
            continue
        pids = node.get("participant_ids")
        if pids is None or len(pids) == 0:
            unassigned_roots.append(root_id)
        elif uid in pids:
            assigned_roots.append(root_id)

    if assigned_roots:
        return assigned_roots
    if unassigned_roots:
        return unassigned_roots[:1]
    return roots[:1]


def detect_divergence_points(
    nodes: list[dict], edges: list[dict]
) -> list[DivergencePoint]:
    """Find divergence points: nodes with out-degree > 1, plus multiple root nodes.

    When the DAG has multiple root nodes (in-degree = 0), a virtual divergence
    with node_id ``__root__`` is added so the user can choose a starting point.
    """
    forward_adj, reverse_adj = build_adjacency(edges)
    result = []

    # Multiple roots are a divergence at the start of the DAG
    roots = find_root_nodes(nodes, reverse_adj)
    if len(roots) > 1:
        result.append(DivergencePoint(node_id="__root__", child_node_ids=roots))

    for n in nodes:
        children = forward_adj.get(n["id"], [])
        if len(children) > 1:
            result.append(DivergencePoint(node_id=n["id"], child_node_ids=children))
    return result


def detect_unresolved_flows(
    nodes: list[dict],
    edges: list[dict],
    participant_ids: list[str],
) -> list[dict]:
    """Detect participants not assigned at divergence points.

    Returns list of {user_id, divergence_node_id, message} for each unresolved flow.
    """
    node_map: dict[str, dict] = {n["id"]: n for n in nodes}
    divergences = detect_divergence_points(nodes, edges)
    warnings: list[dict] = []

    for dp in divergences:
        # Check if any child at this divergence has participant assignments
        assigned_children = []
        unassigned_children = []
        for child_id in dp.child_node_ids:
            child = node_map.get(child_id)
            if child is None:
                continue
            pids = child.get("participant_ids")
            if pids and len(pids) > 0:
                assigned_children.append(child_id)
            else:
                unassigned_children.append(child_id)

        if not assigned_children:
            # No assignments at all — every participant is unresolved
            for uid in participant_ids:
                warnings.append({
                    "user_id": uid,
                    "divergence_node_id": dp.node_id,
                    "message": "No participants assigned at divergence point",
                })
        else:
            for uid in participant_ids:
                # Check if user is explicitly assigned to a branch
                explicitly_assigned = any(
                    uid in (node_map.get(cid, {}).get("participant_ids") or [])
                    for cid in assigned_children
                )
                # If not explicitly assigned, unassigned branches serve as fallback
                if not explicitly_assigned and not unassigned_children:
                    warnings.append({
                        "user_id": uid,
                        "divergence_node_id": dp.node_id,
                        "message": "Participant not assigned at divergence point",
                    })

    return warnings


def detect_merge_nodes(
    nodes: list[dict],
    edges: list[dict],
    participant_ids: list[str] | None = None,
) -> list[MergeNode]:
    """Find merge nodes: in-degree > 1 where incoming edges come from different paths.

    If participant_ids provided, groups incoming edges by which participant paths they belong to.
    Otherwise, simply identifies nodes with multiple incoming edges.
    """
    _, reverse_adj = build_adjacency(edges)
    merge_nodes: list[MergeNode] = []

    for n in nodes:
        parents = reverse_adj.get(n["id"], [])
        if len(parents) > 1:
            merge_nodes.append(
                MergeNode(
                    node_id=n["id"],
                    incoming_path_groups=[parents],
                )
            )

    return merge_nodes
