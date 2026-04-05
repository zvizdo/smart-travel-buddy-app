"use client";

import { useState } from "react";
import { useTripContext } from "@/app/trips/[tripId]/layout";

interface PlanSwitcherProps {
  activePlanId: string | null;
  onPlanSelect: (planId: string) => void;
  userRole?: string;
  onCreateDraft?: () => void;
  isViewingDraft?: boolean;
  draftName?: string | null;
}

const STATUS_BADGE: Record<string, string> = {
  active: "bg-secondary/10 text-secondary",
  draft: "bg-tertiary-container/30 text-on-tertiary-container",
  archived: "bg-surface-high text-on-surface-variant",
};

export function PlanSwitcher({
  activePlanId,
  onPlanSelect,
  userRole,
  onCreateDraft,
  isViewingDraft,
  draftName,
}: PlanSwitcherProps) {
  const { plans, plansLoading } = useTripContext();
  const [open, setOpen] = useState(false);

  const hasMultiplePlans = plans.length > 1;
  const hasDraft = plans.some((p) => p.status === "draft");
  const showDraftPill = userRole === "planner" && !hasDraft && onCreateDraft;

  if (plansLoading || plans.length === 0) return null;
  if (!hasMultiplePlans && !showDraftPill) return null;

  return (
    <div className="relative flex items-center gap-1.5">
      {!hasMultiplePlans && showDraftPill ? (
        <button
          onClick={onCreateDraft}
          className="flex items-center gap-1 rounded-full bg-surface-lowest/80 px-3 py-1.5 text-xs font-semibold text-primary shadow-soft transition-all active:scale-95"
        >
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Draft
        </button>
      ) : null}
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1 rounded-full bg-surface-lowest/80 px-2 py-1.5 text-on-surface shadow-soft transition-all active:scale-95 ${!hasMultiplePlans ? "hidden" : ""}`}
      >
        {/* Layers icon */}
        <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="m12 2 10 6.5v7L12 22 2 15.5v-7L12 2Z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="m2 8.5 10 6.5 10-6.5" />
        </svg>
        {isViewingDraft && (
          <span className="inline-flex items-center rounded-full bg-tertiary-container/30 px-1.5 py-0.5 text-[9px] font-semibold text-on-tertiary-container">
            Draft
          </span>
        )}
        <svg
          className={`h-2.5 w-2.5 transition-transform ${open ? "rotate-180" : ""}`}
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
        <div className="absolute top-full right-0 mt-2 w-56 max-w-[calc(100vw-2rem)] rounded-2xl bg-surface-lowest shadow-float z-50 overflow-hidden animate-fade-in">
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
