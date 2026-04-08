"use client";

interface ActionTaken {
  type: string;
  node_id: string | null;
  description: string;
}

interface ActionBadgesProps {
  actions: ActionTaken[];
}

const ACTION_STYLES: Record<string, { label: string; className: string }> = {
  node_added: {
    label: "Stop added",
    className: "bg-secondary/10 text-secondary",
  },
  node_updated: {
    label: "Stop updated",
    className: "bg-primary/10 text-primary",
  },
  node_deleted: {
    label: "Stop removed",
    className: "bg-error/10 text-error",
  },
  edge_added: {
    label: "Route added",
    className: "bg-amber-500/10 text-amber-700",
  },
  edge_deleted: {
    label: "Route removed",
    className: "bg-error/10 text-error",
  },
  places_searched: {
    label: "Places found",
    className: "bg-[#7c4dff]/10 text-[#5e35b1]",
  },
};

export function ActionBadges({ actions }: ActionBadgesProps) {
  if (actions.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {actions.map((action, i) => {
        const style = ACTION_STYLES[action.type] ?? {
          label: action.type,
          className: "bg-surface-high text-on-surface-variant",
        };
        return (
          <span
            key={i}
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${style.className}`}
            title={style.label}
          >
            {action.description}
          </span>
        );
      })}
    </div>
  );
}
