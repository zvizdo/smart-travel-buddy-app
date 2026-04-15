"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTripContext, type PlanData } from "@/app/trips/[tripId]/layout";
import { useAuth } from "@/components/auth/auth-provider";
import { api } from "@/lib/api";
import { formatNotificationDate } from "@/lib/dates";
import { OfflineBanner, useOnlineStatus } from "@/components/ui/offline-banner";
import { formatUserName } from "@/lib/user-display";
import {
  trackInviteGenerated,
  trackParticipantRoleChanged,
  trackPlanCreated,
  trackPlanDeleted,
  trackPlanPromoted,
} from "@/lib/analytics";

interface InviteResult {
  token: string;
  url: string;
  role: string;
  expires_at: string;
}

const STATUS_BADGE: Record<string, string> = {
  active: "bg-secondary/10 text-secondary",
  draft: "bg-tertiary-container/30 text-on-tertiary-container",
  archived: "bg-surface-high text-on-surface-variant",
};

const ROLE_COLORS: Record<string, string> = {
  admin: "bg-primary/10 text-primary",
  planner: "bg-secondary/10 text-secondary",
  viewer: "bg-surface-high text-on-surface-variant",
};

export default function TripSettingsPage() {
  const { tripId, trip, refetch, plans, plansLoading, setPlans } = useTripContext();
  const { user } = useAuth();

  const online = useOnlineStatus();
  const userRole = user?.uid && trip?.participants?.[user.uid]?.role;
  const isAdmin = userRole === "admin";
  const isPlanner = userRole === "planner";
  const canCreateAlternative = online && (isAdmin || isPlanner);

  const router = useRouter();

  const [inviteRole, setInviteRole] = useState<"admin" | "planner" | "viewer">(
    "planner",
  );
  const [invite, setInvite] = useState<InviteResult | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);

  const [altName, setAltName] = useState("");
  const [altSourcePlanId, setAltSourcePlanId] = useState<string>("");
  const [altIncludeActions, setAltIncludeActions] = useState(false);
  const [creatingAlt, setCreatingAlt] = useState(false);
  const [promoteConfirm, setPromoteConfirm] = useState<string | null>(null);
  const [promoting, setPromoting] = useState(false);

  const effectiveSourcePlanId = altSourcePlanId || trip?.active_plan_id || "";

  async function handleCreateAlternative() {
    if (!altName.trim() || !effectiveSourcePlanId) return;
    setCreatingAlt(true);
    try {
      const result = await api.post<{ plan: PlanData }>(
        `/trips/${tripId}/plans`,
        {
          name: altName.trim(),
          source_plan_id: effectiveSourcePlanId,
          include_actions: altIncludeActions,
        },
      );
      setPlans((prev) => [...prev, result.plan]);
      trackPlanCreated();
      setAltName("");
      setAltSourcePlanId("");
      setAltIncludeActions(false);
    } catch {
      // Error handled by api client
    } finally {
      setCreatingAlt(false);
    }
  }

  async function handlePromotePlan(planId: string) {
    if (promoteConfirm !== planId) {
      setPromoteConfirm(planId);
      return;
    }
    setPromoting(true);
    try {
      await api.post(`/trips/${tripId}/plans/${planId}/promote`);
      trackPlanPromoted();
      setPlans((prev) =>
        prev.map((p) => ({
          ...p,
          status:
            p.id === planId
              ? "active"
              : p.status === "active"
                ? "draft"
                : p.status,
        })),
      );
      setPromoteConfirm(null);
      refetch();
    } catch {
      // Error handled by api client
    } finally {
      setPromoting(false);
    }
  }

  const [deletePlanConfirm, setDeletePlanConfirm] = useState<string | null>(
    null,
  );
  const [deletingPlanId, setDeletingPlanId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDeletePlan(planId: string) {
    if (deletePlanConfirm !== planId) {
      setDeletePlanConfirm(planId);
      return;
    }
    setDeletingPlanId(planId);
    setDeleteError(null);
    try {
      await api.delete(`/trips/${tripId}/plans/${planId}`);
      trackPlanDeleted();
      setPlans((prev) => prev.filter((p) => p.id !== planId));
      setDeletePlanConfirm(null);
    } catch {
      setDeleteError("Couldn't delete this plan — please try again.");
    } finally {
      setDeletingPlanId(null);
    }
  }

  const settings = trip?.settings ?? {};
  const [datetimeFormat, setDatetimeFormat] = useState<string>(
    settings.datetime_format ?? "24h",
  );
  const [dateFormat, setDateFormat] = useState<string>(
    settings.date_format ?? "eu",
  );
  const [distanceUnit, setDistanceUnit] = useState<string>(
    settings.distance_unit ?? "km",
  );
  const savedNoDriveWindow = settings.no_drive_window ?? null;
  const savedMaxDriveHours = settings.max_drive_hours_per_day ?? null;
  const [noDriveEnabled, setNoDriveEnabled] = useState<boolean>(
    savedNoDriveWindow != null,
  );
  const [noDriveStart, setNoDriveStart] = useState<number>(
    savedNoDriveWindow?.start_hour ?? 22,
  );
  const [noDriveEnd, setNoDriveEnd] = useState<number>(
    savedNoDriveWindow?.end_hour ?? 6,
  );
  const [maxDriveEnabled, setMaxDriveEnabled] = useState<boolean>(
    savedMaxDriveHours != null,
  );
  const [maxDriveHours, setMaxDriveHours] = useState<number>(
    savedMaxDriveHours ?? 10,
  );
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [savingTravelRules, setSavingTravelRules] = useState(false);
  const [travelRulesSaved, setTravelRulesSaved] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Participant management
  const [removeConfirm, setRemoveConfirm] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [changingRoleId, setChangingRoleId] = useState<string | null>(null);

  async function handleGenerateInvite() {
    setGenerating(true);
    try {
      const result = await api.post<InviteResult>(
        `/trips/${tripId}/invites`,
        { role: inviteRole, expires_in_hours: 72 },
      );
      setInvite(result);
      trackInviteGenerated(inviteRole);
    } catch {
      // Error handled by api client
    } finally {
      setGenerating(false);
    }
  }

  function handleCopyLink() {
    if (!invite) return;
    const url = `${window.location.origin}${invite.url}`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleSaveSettings() {
    setSavingSettings(true);
    try {
      await api.patch(`/trips/${tripId}/settings`, {
        datetime_format: datetimeFormat,
        date_format: dateFormat,
        distance_unit: distanceUnit,
      });
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 2000);
    } catch {
      // Error handled by api client
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleSaveTravelRules() {
    setSavingTravelRules(true);
    try {
      const payload: Record<string, unknown> = {};
      if (noDriveEnabled) {
        payload.no_drive_window = {
          start_hour: noDriveStart,
          end_hour: noDriveEnd,
        };
      } else {
        payload.clear_no_drive_window = true;
      }
      if (maxDriveEnabled) {
        payload.max_drive_hours_per_day = maxDriveHours;
      } else {
        payload.clear_max_drive_hours = true;
      }
      await api.patch(`/trips/${tripId}/settings`, payload);
      refetch();
      setTravelRulesSaved(true);
      setTimeout(() => setTravelRulesSaved(false), 2000);
    } catch {
      // Error handled by api client
    } finally {
      setSavingTravelRules(false);
    }
  }

  async function handleDeleteTrip() {
    if (!deleteConfirm) {
      setDeleteConfirm(true);
      return;
    }
    setDeleting(true);
    try {
      await api.delete(`/trips/${tripId}`);
      router.push("/");
    } catch {
      setDeleting(false);
      setDeleteConfirm(false);
    }
  }

  async function handleRemoveParticipant(uid: string) {
    if (removeConfirm !== uid) {
      setRemoveConfirm(uid);
      return;
    }
    setRemovingId(uid);
    setRemoveError(null);
    try {
      const result = await api.delete<{ self_removal: boolean }>(
        `/trips/${tripId}/participants/${uid}`,
      );
      setRemoveConfirm(null);
      if (result.self_removal) {
        router.replace("/");
      } else {
        refetch();
      }
    } catch {
      setRemoveError("Couldn't remove this participant — please try again.");
    } finally {
      setRemovingId(null);
    }
  }

  async function handleChangeRole(uid: string, newRole: string) {
    setChangingRoleId(uid);
    try {
      await api.patch(`/trips/${tripId}/participants/${uid}`, { role: newRole });
      trackParticipantRoleChanged(newRole);
      refetch();
    } catch {
      // Error handled by api client
    } finally {
      setChangingRoleId(null);
    }
  }

  const participants = trip?.participants
    ? Object.entries(trip.participants)
    : [];

  const adminCount = participants.filter(
    ([, p]) => (p as { role: string }).role === "admin",
  ).length;

  const settingsChanged =
    datetimeFormat !== (settings.datetime_format ?? "24h") ||
    dateFormat !== (settings.date_format ?? "eu") ||
    distanceUnit !== (settings.distance_unit ?? "km");

  const travelRulesChanged =
    noDriveEnabled !== (savedNoDriveWindow != null) ||
    (noDriveEnabled &&
      savedNoDriveWindow != null &&
      (noDriveStart !== savedNoDriveWindow.start_hour ||
        noDriveEnd !== savedNoDriveWindow.end_hour)) ||
    maxDriveEnabled !== (savedMaxDriveHours != null) ||
    (maxDriveEnabled &&
      savedMaxDriveHours != null &&
      maxDriveHours !== savedMaxDriveHours);

  return (
    <div className="flex flex-col flex-1 bg-surface">
      <OfflineBanner />

      {/* Header */}
      <header className="flex items-center gap-3 px-5 py-4 bg-surface-lowest">
        <button
          onClick={() => router.back()}
          className="h-10 w-10 rounded-full bg-surface-low flex items-center justify-center text-on-surface-variant transition-colors active:bg-surface-container"
          aria-label="Go back"
        >
          <svg
            className="h-5 w-5"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15.75 19.5 8.25 12l7.5-7.5"
            />
          </svg>
        </button>
        <h1 className="text-lg font-bold text-on-surface">Trip Settings</h1>
      </header>

      <div className="flex-1 overflow-y-auto px-5 py-6 space-y-8">
        {/* Display Preferences */}
        <section>
          <h2 className="text-xs font-semibold text-primary tracking-wide uppercase mb-4">
            Display Preferences
          </h2>
          <div className="rounded-2xl bg-surface-lowest p-5 shadow-soft space-y-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-on-surface">
                  Time format
                </p>
                <p className="text-xs text-on-surface-variant mt-0.5">
                  How times are displayed
                </p>
              </div>
              <select
                value={datetimeFormat}
                onChange={(e) => setDatetimeFormat(e.target.value)}
                disabled={!isAdmin}
                className="rounded-xl bg-surface-high px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
              >
                <option value="12h">12-hour</option>
                <option value="24h">24-hour</option>
              </select>
            </div>

            <div className="h-px bg-surface-low" />

            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-on-surface">
                  Date format
                </p>
                <p className="text-xs text-on-surface-variant mt-0.5">
                  How dates are displayed
                </p>
              </div>
              <select
                value={dateFormat}
                onChange={(e) => setDateFormat(e.target.value)}
                disabled={!isAdmin}
                className="rounded-xl bg-surface-high px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
              >
                <option value="us">US (Jun 15, 2026)</option>
                <option value="eu">EU (15 Jun 2026)</option>
                <option value="iso">ISO (2026-06-15)</option>
                <option value="short">Short (Mon, Jun 15)</option>
              </select>
            </div>

            <div className="h-px bg-surface-low" />

            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-on-surface">
                  Distance unit
                </p>
                <p className="text-xs text-on-surface-variant mt-0.5">
                  Kilometers or miles
                </p>
              </div>
              <select
                value={distanceUnit}
                onChange={(e) => setDistanceUnit(e.target.value)}
                disabled={!isAdmin}
                className="rounded-xl bg-surface-high px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
              >
                <option value="km">Kilometers</option>
                <option value="mi">Miles</option>
              </select>
            </div>

            {isAdmin && settingsChanged && (
              <button
                onClick={handleSaveSettings}
                disabled={savingSettings || !online}
                className="w-full rounded-xl gradient-primary py-3 text-sm font-semibold text-on-primary shadow-soft transition-all active:scale-[0.98] disabled:opacity-40 mt-1"
              >
                {savingSettings
                  ? "Saving..."
                  : settingsSaved
                    ? "Saved!"
                    : "Save preferences"}
              </button>
            )}
          </div>
        </section>

        {/* Travel rules */}
        <section>
          <h2 className="text-xs font-semibold text-primary tracking-wide uppercase mb-4">
            Travel Rules
          </h2>
          <p className="text-xs text-on-surface-variant mb-3 -mt-2">
            Smart timing pads overnight stops and caps long driving days so
            auto-scheduled trips don&apos;t place you on the road at 3&nbsp;AM.
          </p>
          <div className="rounded-2xl bg-surface-lowest p-5 shadow-soft space-y-5">
            {/* No-drive window */}
            <div>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-on-surface">
                    No-drive window
                  </p>
                  <p className="text-xs text-on-surface-variant mt-0.5">
                    Overnight hours when driving should pause
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={noDriveEnabled}
                    onChange={(e) => setNoDriveEnabled(e.target.checked)}
                    disabled={!isAdmin}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-surface-high rounded-full peer peer-checked:bg-primary peer-focus:ring-2 peer-focus:ring-primary/30 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-surface-lowest after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-5 peer-disabled:opacity-50" />
                </label>
              </div>
              {noDriveEnabled && (
                <div className="mt-3 flex items-center gap-2">
                  <div className="flex-1">
                    <label className="block text-[11px] text-on-surface-variant mb-1">
                      Start
                    </label>
                    <select
                      value={noDriveStart}
                      onChange={(e) =>
                        setNoDriveStart(parseInt(e.target.value, 10))
                      }
                      disabled={!isAdmin}
                      className="w-full rounded-xl bg-surface-high px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
                    >
                      {Array.from({ length: 24 }, (_, i) => (
                        <option key={i} value={i}>
                          {String(i).padStart(2, "0")}:00
                        </option>
                      ))}
                    </select>
                  </div>
                  <span className="text-xs text-on-surface-variant mt-5">→</span>
                  <div className="flex-1">
                    <label className="block text-[11px] text-on-surface-variant mb-1">
                      End
                    </label>
                    <select
                      value={noDriveEnd}
                      onChange={(e) =>
                        setNoDriveEnd(parseInt(e.target.value, 10))
                      }
                      disabled={!isAdmin}
                      className="w-full rounded-xl bg-surface-high px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
                    >
                      {Array.from({ length: 24 }, (_, i) => (
                        <option key={i} value={i}>
                          {String(i).padStart(2, "0")}:00
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </div>

            <div className="h-px bg-surface-low" />

            {/* Max drive hours per day */}
            <div>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-on-surface">
                    Max drive hours per day
                  </p>
                  <p className="text-xs text-on-surface-variant mt-0.5">
                    Cap before the planner schedules an overnight rest
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={maxDriveEnabled}
                    onChange={(e) => setMaxDriveEnabled(e.target.checked)}
                    disabled={!isAdmin}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-surface-high rounded-full peer peer-checked:bg-primary peer-focus:ring-2 peer-focus:ring-primary/30 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-surface-lowest after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-5 peer-disabled:opacity-50" />
                </label>
              </div>
              {maxDriveEnabled && (
                <div className="mt-3">
                  <div className="flex items-center justify-between gap-3 mb-1">
                    <span className="text-xs text-on-surface-variant">
                      {maxDriveHours}h / day
                    </span>
                  </div>
                  <input
                    type="range"
                    min={4}
                    max={16}
                    step={0.5}
                    value={maxDriveHours}
                    onChange={(e) =>
                      setMaxDriveHours(parseFloat(e.target.value))
                    }
                    disabled={!isAdmin}
                    className="w-full accent-primary disabled:opacity-50"
                  />
                  <div className="flex justify-between text-[10px] text-outline mt-1">
                    <span>4h</span>
                    <span>10h</span>
                    <span>16h</span>
                  </div>
                </div>
              )}
            </div>

            {isAdmin && travelRulesChanged && (
              <button
                onClick={handleSaveTravelRules}
                disabled={savingTravelRules || !online}
                className="w-full rounded-xl gradient-primary py-3 text-sm font-semibold text-on-primary shadow-soft transition-all active:scale-[0.98] disabled:opacity-40 mt-1"
              >
                {savingTravelRules
                  ? "Saving..."
                  : travelRulesSaved
                    ? "Saved!"
                    : "Save travel rules"}
              </button>
            )}
          </div>
        </section>

        {/* Participants */}
        <section>
          <h2 className="text-xs font-semibold text-primary tracking-wide uppercase mb-4">
            Participants
          </h2>
          <div className="space-y-2">
            {participants.map(([uid, p]) => {
              const role = (p as { role: string }).role;
              const displayName = (p as { role: string; display_name?: string }).display_name;
              const isSelf = uid === user?.uid;
              const isRemoving = removingId === uid;
              const isSoleAdmin = role === "admin" && adminCount <= 1;

              return (
                <div
                  key={uid}
                  className={`flex items-center gap-2 rounded-2xl bg-surface-lowest px-4 py-3 shadow-soft transition-opacity ${isRemoving ? "opacity-50 pointer-events-none" : ""}`}
                >
                  <span className="text-sm font-medium text-on-surface truncate flex-1 min-w-0">
                    {isSelf ? "You" : formatUserName(displayName, uid)}
                  </span>

                  {/* Role: selector for admins viewing others, static badge otherwise */}
                  {isAdmin && !isSelf ? (
                    <select
                      value={role}
                      onChange={(e) => handleChangeRole(uid, e.target.value)}
                      disabled={changingRoleId === uid || !online || (isSoleAdmin && role === "admin")}
                      className={`appearance-none rounded-full px-2.5 py-0.5 text-xs font-medium capitalize cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50 disabled:cursor-not-allowed ${ROLE_COLORS[role] || ROLE_COLORS.viewer}`}
                    >
                      <option value="admin">Admin</option>
                      <option value="planner">Planner</option>
                      <option value="viewer">Viewer</option>
                    </select>
                  ) : (
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${ROLE_COLORS[role] || ROLE_COLORS.viewer}`}
                    >
                      {role}
                    </span>
                  )}

                  {/* Remove / Leave button — admin only */}
                  {isAdmin && online && (
                    isSelf ? (
                      <>
                        {isSoleAdmin && (
                          <div className="text-xs text-error font-semibold">
                            You&apos;re the only admin. Assign another admin before you leave.
                          </div>
                        )}
                        {!isSoleAdmin && (
                          <button
                            onClick={() => handleRemoveParticipant(uid)}
                            disabled={isRemoving}
                            className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed ${
                              removeConfirm === uid
                                ? "bg-error text-on-error"
                                : "bg-error/10 text-error"
                            }`}
                          >
                            {isRemoving
                              ? "..."
                              : removeConfirm === uid
                                ? "Confirm"
                                : "Leave"}
                          </button>
                        )}
                      </>
                    ) : (
                      <button
                        onClick={() => handleRemoveParticipant(uid)}
                        disabled={isRemoving || removingId !== null}
                        className={`shrink-0 h-7 w-7 rounded-full flex items-center justify-center transition-all active:scale-95 disabled:opacity-40 ${
                          removeConfirm === uid
                            ? "bg-error text-on-error"
                            : "text-on-surface-variant/60 hover:text-error hover:bg-error/10"
                        }`}
                        aria-label={`Remove ${formatUserName(displayName, uid)}`}
                      >
                        {removeConfirm === uid ? (
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                          </svg>
                        ) : (
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                          </svg>
                        )}
                      </button>
                    )
                  )}
                </div>
              );
            })}

            {/* Last admin warning */}
            {isAdmin && adminCount <= 1 && (
              <p className="text-xs text-on-surface-variant mt-2 px-1">
                You are the only admin. Add another admin before leaving.
              </p>
            )}

            {/* Remove error */}
            {removeError && (
              <div className="rounded-xl bg-error/10 px-4 py-3 flex items-center justify-between" role="alert">
                <span className="text-xs font-medium text-error">{removeError}</span>
                <button
                  onClick={() => setRemoveError(null)}
                  className="text-error/60 hover:text-error ml-3 text-sm"
                  aria-label="Dismiss error"
                >
                  &times;
                </button>
              </div>
            )}
          </div>
        </section>

        {/* Invite */}
        {isAdmin && (
          <section>
            <h2 className="text-xs font-semibold text-primary tracking-wide uppercase mb-4">
              Invite Members
            </h2>
            <div className="rounded-2xl bg-surface-lowest p-5 shadow-soft space-y-4">
              <div className="flex gap-3">
                <select
                  value={inviteRole}
                  onChange={(e) =>
                    setInviteRole(e.target.value as "admin" | "planner" | "viewer")
                  }
                  className="flex-1 rounded-xl bg-surface-high px-3 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30"
                >
                  <option value="admin">Admin</option>
                  <option value="planner">Planner</option>
                  <option value="viewer">Viewer</option>
                </select>
                <button
                  onClick={handleGenerateInvite}
                  disabled={generating || !online}
                  className="rounded-xl gradient-primary px-5 py-2.5 text-sm font-semibold text-on-primary shadow-soft transition-all active:scale-[0.98] disabled:opacity-40"
                >
                  {generating ? "..." : "Generate Link"}
                </button>
              </div>

              {invite && (
                <div className="rounded-xl bg-surface-low p-4 space-y-3">
                  <p className="text-xs text-on-surface-variant">
                    Role: <span className="capitalize font-medium">{invite.role}</span> | Expires:{" "}
                    {formatNotificationDate(invite.expires_at)}
                  </p>
                  <div className="flex gap-2">
                    <input
                      readOnly
                      value={`${typeof window !== "undefined" ? window.location.origin : ""}${invite.url}`}
                      className="flex-1 rounded-xl bg-surface-high px-3 py-2 text-xs font-mono text-on-surface"
                    />
                    <button
                      onClick={handleCopyLink}
                      className="rounded-xl bg-primary/10 px-4 py-2 text-xs font-semibold text-primary transition-all active:scale-95"
                    >
                      {copied ? "Copied!" : "Copy"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {/* Plan Versions */}
        {trip?.active_plan_id && (
          <section>
            <h2 className="text-xs font-semibold text-primary tracking-wide uppercase mb-4">
              Plan Versions
            </h2>
            <div className="space-y-2">
              {plansLoading ? (
                <div className="flex justify-center py-6">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-surface-high border-t-primary" />
                </div>
              ) : (
                plans
                  .sort((a, b) => {
                    const order: Record<string, number> = {
                      active: 0,
                      draft: 1,
                      archived: 2,
                    };
                    return (order[a.status] ?? 3) - (order[b.status] ?? 3);
                  })
                  .map((plan) => {
                    const isDeleting = deletingPlanId === plan.id;
                    return (
                      <div
                        key={plan.id}
                        aria-busy={isDeleting || undefined}
                        className={`flex items-center justify-between rounded-2xl bg-surface-lowest px-4 py-3 shadow-soft transition-opacity ${isDeleting ? "opacity-50 pointer-events-none" : ""}`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm font-medium text-on-surface truncate">
                            {plan.name}
                          </span>
                          <span
                            className={`shrink-0 inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-semibold capitalize ${STATUS_BADGE[plan.status] || STATUS_BADGE.archived}`}
                          >
                            {plan.status}
                          </span>
                        </div>
                        {plan.status !== "active" && canCreateAlternative && (
                          isDeleting ? (
                            <div className="ml-3" role="status" aria-label="Deleting plan">
                              <div className="h-5 w-5 animate-spin rounded-full border-2 border-surface-high border-t-error" />
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5 ml-3">
                              {isAdmin && plan.status === "draft" && (
                                <button
                                  onClick={() => handlePromotePlan(plan.id)}
                                  disabled={promoting}
                                  className={`shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all active:scale-95 disabled:opacity-40 ${
                                    promoteConfirm === plan.id
                                      ? "bg-secondary text-on-secondary"
                                      : "bg-secondary/10 text-secondary"
                                  }`}
                                >
                                  {promoting && promoteConfirm === plan.id
                                    ? "..."
                                    : promoteConfirm === plan.id
                                      ? "Confirm"
                                      : "Promote"}
                                </button>
                              )}
                              <button
                                onClick={() => handleDeletePlan(plan.id)}
                                disabled={deletingPlanId !== null}
                                className={`shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all active:scale-95 disabled:opacity-40 ${
                                  deletePlanConfirm === plan.id
                                    ? "bg-error text-on-error"
                                    : "bg-error/10 text-error"
                                }`}
                              >
                                {deletePlanConfirm === plan.id
                                  ? "Confirm"
                                  : "Delete"}
                              </button>
                            </div>
                          )
                        )}
                      </div>
                    );
                  }))
              }

              {deleteError && (
                <div className="rounded-xl bg-error/10 px-4 py-3 flex items-center justify-between" role="alert">
                  <span className="text-xs font-medium text-error">{deleteError}</span>
                  <button
                    onClick={() => setDeleteError(null)}
                    className="text-error/60 hover:text-error ml-3 text-sm"
                    aria-label="Dismiss error"
                  >
                    &times;
                  </button>
                </div>
              )}

              {canCreateAlternative && (
                <div className="mt-4 rounded-2xl bg-surface-lowest p-5 shadow-soft space-y-5">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium text-on-surface">
                        Clone from
                      </p>
                      <p className="text-xs text-on-surface-variant mt-0.5">
                        Source plan to copy
                      </p>
                    </div>
                    <select
                      value={effectiveSourcePlanId}
                      onChange={(e) => setAltSourcePlanId(e.target.value)}
                      className="rounded-xl bg-surface-high px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30"
                    >
                      {plans.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}{p.status === "active" ? " (Active)" : p.status === "draft" ? " (Draft)" : " (Archived)"}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="h-px bg-surface-low" />

                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium text-on-surface">
                        Copy actions
                      </p>
                      <p className="text-xs text-on-surface-variant mt-0.5">
                        Include notes, todos, and places
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={altIncludeActions}
                      onClick={() => setAltIncludeActions(!altIncludeActions)}
                      className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full transition-colors ${altIncludeActions ? "bg-primary" : "bg-surface-high"}`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-on-primary shadow-soft transition-transform mt-1 ${altIncludeActions ? "translate-x-6 ml-0.5" : "translate-x-0.5"}`}
                      />
                    </button>
                  </div>

                  <div className="h-px bg-surface-low" />

                  <div className="flex gap-3">
                    <input
                      type="text"
                      value={altName}
                      onChange={(e) => setAltName(e.target.value)}
                      placeholder="Alternative plan name..."
                      maxLength={200}
                      className="flex-1 rounded-xl bg-surface-high px-4 py-2.5 text-sm text-on-surface placeholder:text-outline focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                    <button
                      onClick={handleCreateAlternative}
                      disabled={creatingAlt || !altName.trim()}
                      className="shrink-0 rounded-xl gradient-primary px-5 py-2.5 text-sm font-semibold text-on-primary shadow-soft transition-all active:scale-[0.98] disabled:opacity-40"
                    >
                      {creatingAlt ? "..." : "Create"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {/* Danger Zone */}
        {isAdmin && (
          <section className="pb-8">
            <h2 className="text-xs font-semibold text-error tracking-wide uppercase mb-4">
              Danger Zone
            </h2>
            <div className="rounded-2xl bg-error/5 p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-error">
                    Delete this trip
                  </p>
                  <p className="text-xs text-error/70 mt-1 leading-relaxed">
                    Permanently deletes all plans, stops, and connections. This
                    cannot be undone.
                  </p>
                </div>
                <button
                  onClick={handleDeleteTrip}
                  disabled={deleting || !online}
                  className={`ml-2 shrink-0 rounded-full px-5 py-2 text-sm font-semibold transition-all active:scale-95 disabled:opacity-40 ${
                    deleteConfirm
                      ? "bg-error text-on-error"
                      : "bg-error/10 text-error"
                  }`}
                >
                  {deleting
                    ? "..."
                    : deleteConfirm
                      ? "Confirm Delete"
                      : "Delete Trip"}
                </button>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
