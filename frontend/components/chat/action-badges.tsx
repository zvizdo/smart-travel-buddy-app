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
    label: "Added",
    className: "bg-secondary/10 text-secondary",
  },
  node_updated: {
    label: "Updated",
    className: "bg-primary/10 text-primary",
  },
  node_deleted: {
    label: "Removed",
    className: "bg-error/10 text-error",
  },
  cascade_applied: {
    label: "Cascade",
    className: "bg-tertiary-container/30 text-on-tertiary-container",
  },
  places_searched: {
    label: "Places",
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
            title={action.description}
          >
            {style.label}: {action.description}
          </span>
        );
      })}
    </div>
  );
}
