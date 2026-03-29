"use client";

import { useState } from "react";
import { useTripContext } from "@/app/trips/[tripId]/layout";

interface PlanSwitcherProps {
  activePlanId: string | null;
  onPlanSelect: (planId: string) => void;
}

const STATUS_BADGE: Record<string, string> = {
  active: "bg-secondary/10 text-secondary",
  draft: "bg-tertiary-container/30 text-on-tertiary-container",
  archived: "bg-surface-high text-on-surface-variant",
};

export function PlanSwitcher({
  activePlanId,
  onPlanSelect,
}: PlanSwitcherProps) {
  const { plans, plansLoading } = useTripContext();
  const [open, setOpen] = useState(false);

  const activePlan = plans.find((p) => p.id === activePlanId);
  const hasMultiplePlans = plans.length > 1;

  if (plansLoading || plans.length === 0) return null;
  if (!hasMultiplePlans) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-full bg-surface-lowest/80 px-3 py-1.5 text-xs font-semibold text-on-surface shadow-soft transition-all active:scale-95"
      >
        <span className="truncate max-w-[100px]">
          {activePlan?.name ?? "Plan"}
        </span>
        <svg
          className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-2 w-56 rounded-2xl bg-surface-lowest shadow-float z-50 overflow-hidden animate-fade-in">
          {plans
            .sort((a, b) => {
              const order = { active: 0, draft: 1, archived: 2 };
              return (
                (order[a.status as keyof typeof order] ?? 3) -
                (order[b.status as keyof typeof order] ?? 3)
              );
            })
            .map((plan) => (
              <button
                key={plan.id}
                onClick={() => {
                  onPlanSelect(plan.id);
                  setOpen(false);
                }}
                className={`w-full text-left px-4 py-3 text-xs flex items-center justify-between transition-colors hover:bg-surface-low ${
                  plan.id === activePlanId
                    ? "bg-primary/5 font-semibold"
                    : ""
                }`}
              >
                <span className="truncate text-on-surface">{plan.name}</span>
                <span
                  className={`ml-2 shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize ${STATUS_BADGE[plan.status] || STATUS_BADGE.archived}`}
                >
                  {plan.status}
                </span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
