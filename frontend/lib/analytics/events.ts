"use client";

import { getAnalyticsClient } from "./client";

export type MutationSource = "ui" | "agent" | "import_build";
export type MutationAction = "create" | "edit" | "delete" | "branch" | "split" | "insert";
export type MutationEntity = "node" | "edge";
export type NodeActionKind = "added" | "deleted" | "toggled";
export type NodeActionSource = "ui" | "agent" | "mcp";
export type SignInProvider = "google" | "apple" | "yahoo";
export type View = "map" | "timeline";
export type PathMode = "all" | "mine";
export type NavTab = "map" | "agent" | "settings";

interface DagMutationParams {
  source: MutationSource;
  action: MutationAction;
  entity: MutationEntity;
  node_type?: string;
  travel_mode?: string;
  fields_changed?: string;
  node_count?: number;
}

interface NodeActionParams {
  action: NodeActionKind;
  action_type: string;
  source: NodeActionSource;
}

function track(name: string, params?: Record<string, unknown>): void {
  getAnalyticsClient().logEvent(name, params);
}

// DAG mutations (single event name, rich params)
export function trackDagMutation(params: DagMutationParams): void {
  track("dag_mutation", params as unknown as Record<string, unknown>);
}

export function trackNodeAction(params: NodeActionParams): void {
  track("node_action", params as unknown as Record<string, unknown>);
}

// Views / navigation
export function trackViewChanged(from: View, to: View): void {
  track("view_changed", { from, to });
}
export function trackTimelineZoomChanged(level: number): void {
  track("timeline_zoom_changed", { level });
}
export function trackPathModeToggled(mode: PathMode): void {
  track("path_mode_toggled", { mode });
}
export function trackNodeOpened(node_type?: string): void {
  track("node_opened", { node_type });
}
export function trackEdgeOpened(travel_mode?: string): void {
  track("edge_opened", { travel_mode });
}
export function trackScreenView(screen_name: string, params?: Record<string, unknown>): void {
  track("screen_view", { screen_name, ...params });
}

// Auth
export function trackSignInInitiated(provider: SignInProvider): void {
  track("signin_initiated", { provider });
}
export function trackSignInCompleted(provider?: SignInProvider): void {
  track("signin_completed", provider ? { provider } : undefined);
}
export function trackSignOut(): void {
  track("signout");
}
export function trackProfileUpdated(field: string): void {
  track("profile_updated", { field });
}
export function trackAnalyticsToggled(enabled: boolean): void {
  track("analytics_toggled", { enabled });
}
export function trackLocationTrackingToggled(enabled: boolean): void {
  track("location_tracking_toggled", { enabled });
}

// Trips / plans
export function trackTripsListLoaded(count: number): void {
  track("trips_list_loaded", { count });
}
export function trackTripOpened(trip_id: string, role?: string): void {
  track("trip_opened", { trip_id, role });
}
export function trackTripCreated(): void {
  track("trip_created");
}
export function trackPlanCreated(): void {
  track("plan_created");
}
export function trackPlanPromoted(): void {
  track("plan_promoted");
}
export function trackPlanDeleted(): void {
  track("plan_deleted");
}

// Import
export function trackImportMessageSent(length: number): void {
  track("import_message_sent", { length });
}
export function trackImportBuildStarted(): void {
  track("import_build_started");
}
export function trackImportBuildCompleted(params: {
  node_count: number;
  edge_count: number;
  duration_ms?: number;
}): void {
  track("import_build_completed", params);
}
export function trackImportBuildFailed(reason?: string): void {
  track("import_build_failed", reason ? { reason } : undefined);
}
export function trackImportRetry(): void {
  track("import_retry");
}

// Agent
export function trackAgentOpened(): void {
  track("agent_opened");
}
export function trackAgentClosed(): void {
  track("agent_closed");
}
export function trackAgentMessageSent(length: number): void {
  track("agent_message_sent", { length });
}
export function trackAgentResponseReceived(params: {
  action_count: number;
  preference_count: number;
  duration_ms?: number;
}): void {
  track("agent_response_received", params);
}

// Collab
export function trackInviteGenerated(role: string): void {
  track("invite_generated", { role });
}
export function trackInviteAccepted(role?: string): void {
  track("invite_accepted", role ? { role } : undefined);
}
export function trackDivergenceResolved(): void {
  track("divergence_resolved");
}
export function trackParticipantRoleChanged(new_role: string): void {
  track("participant_role_changed", { new_role });
}

// Location
export function trackPulseInitiated(): void {
  track("pulse_initiated");
}
export function trackPulseSent(): void {
  track("pulse_sent");
}
export function trackPulseError(code?: string): void {
  track("pulse_error", code ? { code } : undefined);
}

// UI / settings
export function trackNavTabClicked(tab: NavTab): void {
  track("nav_tab_clicked", { tab });
}
export function trackSettingsOpened(): void {
  track("settings_opened");
}
export function trackImpactPreviewShown(params: {
  shifts_count: number;
  conflicts_count: number;
}): void {
  track("impact_preview_shown", params);
}
export function trackTimingShifted(node_count: number): void {
  track("timing_shifted", { node_count });
}
