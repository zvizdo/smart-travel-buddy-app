"use client";

import { useMemo, useState } from "react";
import { type DocumentData } from "firebase/firestore";

interface ConnectionSelectorProps {
  allNodes: DocumentData[];
  allEdges: DocumentData[];
  incomingNodes: string[];
  outgoingNodes: string[];
  onIncomingChange: (ids: string[]) => void;
  onOutgoingChange: (ids: string[]) => void;
  onSwitchToSimple: () => void;
}

/**
 * Get all ancestors of a set of node IDs by following edges backwards.
 */
function getAncestors(nodeIds: string[], edges: DocumentData[]): Set<string> {
  const reverseAdj = new Map<string, string[]>();
  for (const e of edges) {
    const parents = reverseAdj.get(e.to_node_id) ?? [];
    parents.push(e.from_node_id);
    reverseAdj.set(e.to_node_id, parents);
  }
  const visited = new Set<string>();
  const stack = [...nodeIds];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const parent of reverseAdj.get(current) ?? []) {
      if (!visited.has(parent)) {
        visited.add(parent);
        stack.push(parent);
      }
    }
  }
  return visited;
}

/**
 * Get all descendants of a set of node IDs by following edges forward.
 */
function getDescendants(nodeIds: string[], edges: DocumentData[]): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const children = adj.get(e.from_node_id) ?? [];
    children.push(e.to_node_id);
    adj.set(e.from_node_id, children);
  }
  const visited = new Set<string>();
  const stack = [...nodeIds];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const child of adj.get(current) ?? []) {
      if (!visited.has(child)) {
        visited.add(child);
        stack.push(child);
      }
    }
  }
  return visited;
}

function NodePicker({
  label,
  direction,
  allNodes,
  selectedIds,
  disabledIds,
  onAdd,
  onRemove,
}: {
  label: string;
  direction: "incoming" | "outgoing";
  allNodes: DocumentData[];
  selectedIds: string[];
  disabledIds: Set<string>;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filteredNodes = useMemo(() => {
    const selected = new Set(selectedIds);
    return allNodes.filter((n) => {
      if (selected.has(n.id)) return false;
      if (!search) return true;
      return n.name?.toLowerCase().includes(search.toLowerCase());
    });
  }, [allNodes, selectedIds, search]);

  const selectedNodes = useMemo(
    () => selectedIds.map((id) => allNodes.find((n) => n.id === id)).filter(Boolean),
    [selectedIds, allNodes],
  );

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-1 px-3 pt-2.5 pb-1.5">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-primary shrink-0"
        >
          {direction === "incoming" ? (
            <path d="M19 12H5M12 5l-7 7 7 7" />
          ) : (
            <path d="M5 12h14M12 5l7 7-7 7" />
          )}
        </svg>
        <span className="text-[10px] font-semibold tracking-wide uppercase text-on-surface-variant">
          {label}
        </span>
      </div>

      <div className="px-2 space-y-1.5">
        {selectedNodes.map((n) => (
          <div
            key={n!.id}
            className="flex items-center gap-1.5 rounded-lg bg-surface-lowest px-2.5 py-1.5 text-xs font-medium text-on-surface shadow-soft"
          >
            <span className="h-2 w-2 rounded-full bg-primary shrink-0" />
            <span className="truncate flex-1">{n!.name}</span>
            <button
              type="button"
              onClick={() => onRemove(n!.id)}
              className="p-1 -m-1 text-on-surface-variant hover:text-error transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        ))}

        {!open ? (
          <button
            type="button"
            onClick={() => { setOpen(true); setSearch(""); }}
            className="flex items-center gap-1.5 rounded-lg border border-dashed border-outline-variant/50 px-2.5 py-2.5 text-xs text-on-surface-variant w-full hover:bg-surface-low hover:border-outline-variant transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Add {direction === "incoming" ? "incoming" : "outgoing"}
          </button>
        ) : (
          <div className="relative">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search stops..."
              autoFocus
              className="w-full rounded-lg bg-surface-lowest ring-2 ring-primary/30 px-2.5 py-1.5 text-xs focus:outline-none"
              onBlur={() => setTimeout(() => setOpen(false), 200)}
            />
            {filteredNodes.length > 0 && (
              <div className="absolute z-20 mt-1 rounded-xl bg-surface-lowest shadow-float border border-outline-variant/20 max-h-36 overflow-y-auto w-full">
                {filteredNodes.map((n) => {
                  const disabled = disabledIds.has(n.id);
                  return (
                    <button
                      key={n.id}
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        onAdd(n.id);
                        setOpen(false);
                      }}
                      className={`flex items-center gap-2 px-3 py-2 text-xs w-full text-left ${
                        disabled
                          ? "opacity-60 cursor-not-allowed bg-error/5"
                          : "hover:bg-surface-low cursor-pointer"
                      }`}
                    >
                      <span className="h-2 w-2 rounded-full bg-primary/60 shrink-0" />
                      <span className="truncate flex-1">{n.name}</span>
                      {disabled && (
                        <span className="text-[10px] text-error font-medium shrink-0">Creates loop</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {selectedIds.length === 0 && !open && (
        <p className="text-[10px] italic text-on-surface-variant px-3 py-1">
          No {direction} — {direction === "incoming" ? "first stop" : "last stop"}
        </p>
      )}
    </div>
  );
}

export function ConnectionSelector({
  allNodes,
  allEdges,
  incomingNodes,
  outgoingNodes,
  onIncomingChange,
  onOutgoingChange,
  onSwitchToSimple,
}: ConnectionSelectorProps) {
  // Compute which nodes would create cycles if selected
  const incomingDisabledIds = useMemo(() => {
    // If we have outgoing nodes, any ancestor of those + the outgoing nodes themselves
    // would create a cycle via: ancestor -> ... -> outgoing -> new -> incoming (which is ancestor)
    if (outgoingNodes.length === 0) return new Set<string>();
    const descendants = getDescendants(outgoingNodes, allEdges);
    // Also include the outgoing nodes themselves
    for (const id of outgoingNodes) descendants.add(id);
    return descendants;
  }, [outgoingNodes, allEdges]);

  const outgoingDisabledIds = useMemo(() => {
    // If we have incoming nodes, any descendant of those + the incoming nodes themselves
    if (incomingNodes.length === 0) return new Set<string>();
    const ancestors = getAncestors(incomingNodes, allEdges);
    for (const id of incomingNodes) ancestors.add(id);
    return ancestors;
  }, [incomingNodes, allEdges]);

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-xs text-on-surface-variant">Connections</label>
        <button
          type="button"
          onClick={onSwitchToSimple}
          className="text-xs font-medium text-primary hover:text-primary/80 transition-colors"
        >
          Simple mode
        </button>
      </div>
      <div className="rounded-xl bg-surface-high p-0.5 flex">
        <NodePicker
          label="Coming from"
          direction="incoming"
          allNodes={allNodes}
          selectedIds={incomingNodes}
          disabledIds={incomingDisabledIds}
          onAdd={(id) => onIncomingChange([...incomingNodes, id])}
          onRemove={(id) => onIncomingChange(incomingNodes.filter((i) => i !== id))}
        />
        <div className="w-px bg-outline-variant/20 self-stretch my-2" />
        <NodePicker
          label="Going to"
          direction="outgoing"
          allNodes={allNodes}
          selectedIds={outgoingNodes}
          disabledIds={outgoingDisabledIds}
          onAdd={(id) => onOutgoingChange([...outgoingNodes, id])}
          onRemove={(id) => onOutgoingChange(outgoingNodes.filter((i) => i !== id))}
        />
      </div>
    </div>
  );
}
