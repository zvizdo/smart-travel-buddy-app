"use client";

import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { formatUserName } from "@/lib/user-display";

interface NodeInfo {
  id: string;
  name: string;
  type: string;
  participant_ids?: string[] | null;
}

interface EdgeInfo {
  from_node_id: string;
  to_node_id: string;
}

interface UnresolvedEntry {
  user_id: string;
  divergence_node_id: string;
}

interface DivergenceResolverProps {
  tripId: string;
  planId: string;
  nodes: NodeInfo[];
  edges: EdgeInfo[];
  unresolved: UnresolvedEntry[];
  myPath: string[] | null;
  participants: Record<string, { role: string; display_name?: string }>;
  currentUserId: string;
  userRole: string;
  hidden?: boolean;
}

interface ChildChoice {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  participantIds: string[] | null;
}

interface DivergenceInfo {
  divergenceNodeId: string;
  divergenceNodeName: string;
  children: ChildChoice[];
}

const TYPE_ICONS: Record<string, string> = {
  city: "\u{1F3D9}\uFE0F",
  hotel: "\u{1F3E8}",
  restaurant: "\u{1F37D}\uFE0F",
  place: "\u{1F4CD}",
  activity: "\u{1F3AF}",
};

export function DivergenceResolver({
  tripId,
  planId,
  nodes,
  edges,
  unresolved,
  myPath,
  participants,
  currentUserId,
  userRole,
  hidden,
}: DivergenceResolverProps) {
  const [saving, setSaving] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(true);

  const isAdmin = userRole === "admin";

  const nodeMap = useMemo(() => {
    const m = new Map<string, NodeInfo>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);

  const adj = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const e of edges) {
      const children = m.get(e.from_node_id) ?? [];
      children.push(e.to_node_id);
      m.set(e.from_node_id, children);
    }
    return m;
  }, [edges]);

  const allDivergences: DivergenceInfo[] = useMemo(() => {
    const result: DivergenceInfo[] = [];

    // Detect multiple root nodes as a virtual divergence at __root__
    const hasParent = new Set<string>();
    for (const e of edges) hasParent.add(e.to_node_id);
    const roots = nodes.filter((n) => !hasParent.has(n.id));
    if (roots.length > 1) {
      const rootChildren = roots.map((r) => ({
        nodeId: r.id,
        nodeName: r.name,
        nodeType: r.type,
        participantIds: r.participant_ids ?? null,
      }));
      result.push({
        divergenceNodeId: "__root__",
        divergenceNodeName: "Start",
        children: rootChildren,
      });
    }

    for (const [nodeId, childIds] of adj) {
      if (childIds.length <= 1) continue;
      const divNode = nodeMap.get(nodeId);
      const children = childIds
        .map((cid) => {
          const child = nodeMap.get(cid);
          if (!child) return null;
          return {
            nodeId: child.id,
            nodeName: child.name,
            nodeType: child.type,
            participantIds: child.participant_ids ?? null,
          };
        })
        .filter(Boolean) as ChildChoice[];
      if (children.length > 1) {
        result.push({
          divergenceNodeId: nodeId,
          divergenceNodeName: divNode?.name ?? nodeId,
          children,
        });
      }
    }
    return result;
  }, [adj, nodeMap, nodes, edges]);

  const myPathSet = useMemo(
    () => (myPath ? new Set(myPath) : null),
    [myPath],
  );

  const myDivergenceStatus = useMemo(() => {
    const statuses: {
      info: DivergenceInfo;
      status: "unresolved" | "chosen";
      chosenNodeId?: string;
      chosenNodeName?: string;
    }[] = [];

    for (const div of allDivergences) {
      // __root__ is a virtual divergence for multiple starting points — always show it
      if (div.divergenceNodeId !== "__root__" && myPathSet && !myPathSet.has(div.divergenceNodeId))
        continue;

      const chosen = div.children.find(
        (c) => c.participantIds && c.participantIds.includes(currentUserId),
      );
      if (chosen) {
        statuses.push({
          info: div,
          status: "chosen",
          chosenNodeId: chosen.nodeId,
          chosenNodeName: chosen.nodeName,
        });
      } else {
        statuses.push({ info: div, status: "unresolved" });
      }
    }
    return statuses;
  }, [allDivergences, currentUserId, myPathSet]);

  const otherUsersUnresolved = useMemo(() => {
    if (!isAdmin) return [];
    const participantUids = Object.keys(participants);
    const result: {
      userId: string;
      divergenceInfo: DivergenceInfo;
    }[] = [];

    for (const uid of participantUids) {
      if (uid === currentUserId) continue;
      for (const div of allDivergences) {
        const chosen = div.children.find(
          (c) => c.participantIds && c.participantIds.includes(uid),
        );
        if (!chosen) {
          result.push({ userId: uid, divergenceInfo: div });
        }
      }
    }
    return result;
  }, [isAdmin, participants, currentUserId, allDivergences]);

  const myUnresolved = myDivergenceStatus.filter(
    (d) => d.status === "unresolved",
  );
  const myChosen = myDivergenceStatus.filter((d) => d.status === "chosen");

  const totalIssues = myUnresolved.length + otherUsersUnresolved.length;

  if (
    myUnresolved.length === 0 &&
    myChosen.length === 0 &&
    otherUsersUnresolved.length === 0
  )
    return null;

  async function handleChoose(nodeId: string, forUserId?: string) {
    setSaving(nodeId);
    try {
      if (forUserId && forUserId !== currentUserId) {
        const node = nodeMap.get(nodeId);
        const currentPids = node?.participant_ids
          ? [...node.participant_ids]
          : [];
        if (!currentPids.includes(forUserId)) {
          currentPids.push(forUserId);
        }
        await api.patch(
          `/trips/${tripId}/plans/${planId}/nodes/${nodeId}/participants`,
          { participant_ids: currentPids },
        );
      } else {
        await api.post(
          `/trips/${tripId}/plans/${planId}/nodes/${nodeId}/choose`,
        );
      }
    } catch {
      // Error handled by api client
    } finally {
      setSaving(null);
    }
  }

  async function handleUnchoose(nodeId: string) {
    setSaving(nodeId);
    try {
      await api.delete(
        `/trips/${tripId}/plans/${planId}/nodes/${nodeId}/choose`,
      );
    } catch {
      // Error handled by api client
    } finally {
      setSaving(null);
    }
  }

  return (
    <div
      className={`absolute bottom-[var(--bottom-nav-height,56px)] left-0 right-0 z-20 flex flex-col items-center ${hidden ? "invisible pointer-events-none" : ""}`}
    >
      {/* Content expands upward */}
      {!collapsed && (
        <div className="w-full rounded-t-3xl bg-surface-lowest/95 backdrop-blur-sm shadow-float max-h-[40vh] overflow-y-auto">
          {/* My unresolved divergences */}
          {myUnresolved.length > 0 && (
            <div className="px-5 pt-4 pb-2">
              <h3 className="text-sm font-bold text-on-surface">
                Choose your route
              </h3>
            </div>
          )}
          {myUnresolved.map(({ info: div }) => (
            <div
              key={div.divergenceNodeId}
              className="mx-5 mb-3 rounded-2xl bg-tertiary-container/15 p-4"
            >
              <p className="text-xs font-semibold text-on-tertiary-container mb-3">
                {div.divergenceNodeId === "__root__"
                  ? "Choose your starting point"
                  : `At ${div.divergenceNodeName}, which way?`}
              </p>
              <div className="flex gap-2">
                {div.children.map((child) => (
                  <button
                    key={child.nodeId}
                    onClick={() => handleChoose(child.nodeId)}
                    disabled={saving !== null}
                    className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-primary/10 px-3 py-3 text-sm font-semibold text-primary transition-all active:scale-95 disabled:opacity-40"
                  >
                    <span>
                      {TYPE_ICONS[child.nodeType] || "\u{1F4CD}"}
                    </span>
                    <span className="truncate">{child.nodeName}</span>
                    {saving === child.nodeId && (
                      <span className="text-xs">...</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}

          {/* My resolved choices */}
          {myChosen.length > 0 && (
            <div className="px-5 pt-3 pb-1">
              <p className="text-xs text-on-surface-variant font-semibold">
                Your choices
              </p>
            </div>
          )}
          {myChosen.map(({ info: div, chosenNodeId, chosenNodeName }) => (
            <div
              key={div.divergenceNodeId}
              className="mx-5 mb-3 rounded-2xl bg-surface-low p-4"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-on-surface-variant">
                    {div.divergenceNodeId === "__root__"
                      ? "Starting point"
                      : `At ${div.divergenceNodeName}`}
                  </p>
                  <p className="text-sm font-semibold text-on-surface mt-0.5">
                    {TYPE_ICONS[
                      nodeMap.get(chosenNodeId!)?.type ?? "place"
                    ] || "\u{1F4CD}"}{" "}
                    {chosenNodeName}
                  </p>
                </div>
                <button
                  onClick={() => handleUnchoose(chosenNodeId!)}
                  disabled={saving !== null}
                  className="rounded-full bg-surface-high px-3.5 py-1.5 text-xs font-semibold text-on-surface-variant transition-all active:scale-95 disabled:opacity-40"
                >
                  Change
                </button>
              </div>
            </div>
          ))}

          {/* Admin: other users' unresolved */}
          {isAdmin && otherUsersUnresolved.length > 0 && (
            <>
              <div className="px-5 pt-3 pb-1">
                <div className="h-px bg-surface-low mb-3" />
                <p className="text-xs text-on-surface-variant font-semibold">
                  Other participants
                </p>
              </div>
              {otherUsersUnresolved.map(
                ({ userId, divergenceInfo: div }) => (
                  <div
                    key={`${div.divergenceNodeId}-${userId}`}
                    className="mx-5 mb-3 rounded-2xl bg-tertiary-container/15 p-4"
                  >
                    <p className="text-xs font-semibold text-on-tertiary-container mb-3">
                      {formatUserName(participants[userId]?.display_name, userId)}{" "}
                      {div.divergenceNodeId === "__root__"
                        ? "starting point"
                        : `at ${div.divergenceNodeName}`}
                    </p>
                    <div className="flex gap-2">
                      {div.children.map((child) => (
                        <button
                          key={child.nodeId}
                          onClick={() => handleChoose(child.nodeId, userId)}
                          disabled={saving !== null}
                          className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-surface-high px-3 py-2.5 text-xs font-semibold text-on-surface transition-all active:scale-95 disabled:opacity-40"
                        >
                          <span>
                            {TYPE_ICONS[child.nodeType] || "\u{1F4CD}"}
                          </span>
                          <span className="truncate">{child.nodeName}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ),
              )}
            </>
          )}

          <div className="h-3" />
        </div>
      )}

      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="mx-auto rounded-t-2xl bg-surface-lowest/95 backdrop-blur-sm px-5 py-2 text-xs font-semibold text-primary shadow-float transition-colors active:bg-surface-low"
      >
        {collapsed
          ? `${totalIssues > 0 ? `${totalIssues} unresolved route${totalIssues !== 1 ? "s" : ""}` : "Path choices"}`
          : "Collapse"}
      </button>
    </div>
  );
}
