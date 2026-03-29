"use client";

interface PathWarning {
  user_id: string;
  divergence_node_id: string;
  divergence_node_name?: string;
  user_name?: string;
}

interface PathWarningsProps {
  warnings: PathWarning[];
  onAssign?: (nodeId: string) => void;
}

export function PathWarnings({ warnings, onAssign }: PathWarningsProps) {
  if (warnings.length === 0) return null;

  return (
    <div className="absolute top-28 left-3 right-3 z-10 rounded-2xl glass-panel-dense p-4 shadow-float">
      <p className="text-xs font-bold text-on-tertiary-container mb-2">
        Unresolved paths ({warnings.length})
      </p>
      <div className="space-y-1.5">
        {warnings.map((w, i) => (
          <div key={i} className="flex items-center justify-between text-xs">
            <span className="text-on-surface-variant">
              {w.user_name || w.user_id} needs assignment at{" "}
              {w.divergence_node_name || w.divergence_node_id}
            </span>
            {onAssign && (
              <button
                onClick={() => onAssign(w.divergence_node_id)}
                className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary ml-2 transition-all active:scale-95"
              >
                Assign
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
