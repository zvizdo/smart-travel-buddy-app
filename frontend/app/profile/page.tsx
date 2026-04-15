"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { updateProfile } from "firebase/auth";
import { useAuth } from "@/components/auth/auth-provider";
import { getFirebaseAuth } from "@/lib/firebase";
import { api } from "@/lib/api";
import {
  getAnalyticsClient,
  trackAnalyticsToggled,
  trackLocationTrackingToggled,
  trackProfileUpdated,
} from "@/lib/analytics";

interface UserProfile {
  id: string;
  display_name: string;
  email: string;
  location_tracking_enabled: boolean;
  analytics_enabled: boolean;
  created_at: string;
}

export default function ProfilePage() {
  const { user, loading: authLoading, signOut } = useAuth();
  const router = useRouter();

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [savingLocation, setSavingLocation] = useState(false);
  const [savingAnalytics, setSavingAnalytics] = useState(false);

  // API Key state
  const [apiKeys, setApiKeys] = useState<
    {
      id: string;
      name: string;
      key_prefix: string;
      is_active: boolean;
      created_at: string;
      last_used_at: string | null;
    }[]
  >([]);
  const [loadingKeys, setLoadingKeys] = useState(false);
  const [creatingKey, setCreatingKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [createdKeyValue, setCreatedKeyValue] = useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const [showSetupGuide, setShowSetupGuide] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.replace("/sign-in");
      return;
    }
    api
      .get<UserProfile>("/users/me")
      .then((data) => {
        setProfile(data);
        setNameValue(data.display_name);
      })
      .catch(() => { })
      .finally(() => setLoading(false));

    // Fetch API keys
    setLoadingKeys(true);
    api
      .get<{ api_keys: typeof apiKeys }>("/users/me/api-keys")
      .then((data) => setApiKeys(data.api_keys.filter((k) => k.is_active)))
      .catch(() => { })
      .finally(() => setLoadingKeys(false));
  }, [user, authLoading, router]);

  if (authLoading || !user) {
    return (
      <div className="flex flex-1 items-center justify-center bg-surface">
        <div className="h-8 w-8 animate-spin rounded-full border-3 border-surface-high border-t-primary" />
      </div>
    );
  }

  async function handleSaveName() {
    if (!nameValue.trim() || nameValue.trim() === profile?.display_name) {
      setEditingName(false);
      return;
    }
    setSavingName(true);
    try {
      const auth = getFirebaseAuth();
      if (auth.currentUser) {
        await updateProfile(auth.currentUser, {
          displayName: nameValue.trim(),
        });
      }
      const updated = await api.patch<UserProfile>("/users/me", {
        display_name: nameValue.trim(),
      });
      setProfile(updated);
      trackProfileUpdated("display_name");
      setEditingName(false);
    } catch {
      // Error handled by api client
    } finally {
      setSavingName(false);
    }
  }

  async function handleToggleLocation() {
    if (!profile) return;
    setSavingLocation(true);
    const next = !profile.location_tracking_enabled;
    try {
      const updated = await api.patch<UserProfile>("/users/me", {
        location_tracking_enabled: next,
      });
      setProfile(updated);
      trackLocationTrackingToggled(next);
    } catch {
      // Error handled by api client
    } finally {
      setSavingLocation(false);
    }
  }

  async function handleToggleAnalytics() {
    if (!profile) return;
    setSavingAnalytics(true);
    const next = !profile.analytics_enabled;
    try {
      if (!next) {
        trackAnalyticsToggled(false);
      }
      const updated = await api.patch<UserProfile>("/users/me", {
        analytics_enabled: next,
      });
      setProfile(updated);
      getAnalyticsClient().setEnabled(next);
      if (next) {
        trackAnalyticsToggled(true);
      }
    } catch {
      // Error handled by api client
    } finally {
      setSavingAnalytics(false);
    }
  }

  async function handleCreateApiKey() {
    if (!newKeyName.trim()) return;
    setCreatingKey(true);
    try {
      const result = await api.post<{
        id: string;
        name: string;
        key_prefix: string;
        key: string;
        created_at: string;
      }>("/users/me/api-keys", { name: newKeyName.trim() });
      setCreatedKeyValue(result.key);
      setApiKeys((prev) => [
        ...prev,
        {
          id: result.id,
          name: result.name,
          key_prefix: result.key_prefix,
          is_active: true,
          created_at: result.created_at,
          last_used_at: null,
        },
      ]);
      setNewKeyName("");
      setShowKeyForm(false);
    } catch {
      // Error handled by api client
    } finally {
      setCreatingKey(false);
    }
  }

  async function handleRevokeKey(keyId: string) {
    try {
      await api.delete(`/users/me/api-keys/${keyId}`);
      setApiKeys((prev) => prev.filter((k) => k.id !== keyId));
      setConfirmRevokeId(null);
    } catch {
      // Error handled by api client
    }
  }

  function handleCopyKey() {
    if (createdKeyValue) {
      navigator.clipboard.writeText(createdKeyValue);
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    }
  }

  async function handleSignOut() {
    await signOut();
    router.push("/sign-in");
  }

  const initials = (() => {
    const name = profile?.display_name || user.displayName || "";
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase() || "?";
  })();

  return (
    <div className="flex flex-col flex-1 bg-surface">
      {/* Header */}
      <header className="flex items-center gap-3 px-5 py-4 bg-surface-lowest">
        <button
          onClick={() => router.back()}
          className="h-10 w-10 rounded-full bg-surface-low flex items-center justify-center text-on-surface-variant transition-colors active:bg-surface-container"
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
        <h1 className="text-lg font-bold text-on-surface">Profile</h1>
      </header>

      <div className="flex-1 overflow-y-auto">
        {/* Avatar & Name */}
        <div className="flex flex-col items-center pt-8 pb-6 px-5">
          <div className="h-20 w-20 rounded-full gradient-primary flex items-center justify-center text-2xl font-bold text-on-primary shadow-ambient mb-4">
            {initials}
          </div>

          {loading ? (
            <div className="h-6 w-32 rounded bg-surface-high animate-pulse" />
          ) : editingName ? (
            <div className="flex items-center gap-2 w-full max-w-xs">
              <input
                type="text"
                value={nameValue}
                onChange={(e) => setNameValue(e.target.value)}
                maxLength={200}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveName();
                  if (e.key === "Escape") {
                    setNameValue(profile?.display_name || "");
                    setEditingName(false);
                  }
                }}
                className="flex-1 rounded-xl bg-surface-high px-4 py-2.5 text-sm text-on-surface text-center placeholder:text-outline focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              <button
                onClick={handleSaveName}
                disabled={savingName}
                className="rounded-xl gradient-primary px-4 py-2.5 text-sm font-semibold text-on-primary shadow-soft transition-all active:scale-[0.98] disabled:opacity-40"
              >
                {savingName ? "..." : "Save"}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setEditingName(true)}
              className="flex items-center gap-2 group"
            >
              <h2 className="text-xl font-bold text-on-surface">
                {profile?.display_name || user.displayName || "Explorer"}
              </h2>
              <svg
                className="h-4 w-4 text-on-surface-variant opacity-0 group-hover:opacity-100 transition-opacity"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10"
                />
              </svg>
            </button>
          )}

          <p className="text-sm text-on-surface-variant mt-1">
            {profile?.email || user.email || ""}
          </p>
        </div>

        <div className="px-5 space-y-8 pb-8">
          {/* Personal Information */}
          <section>
            <h3 className="text-xs font-semibold text-primary tracking-wide uppercase mb-4">
              Personal Information
            </h3>
            <div className="rounded-2xl bg-surface-lowest p-5 shadow-soft space-y-5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-on-surface">
                    Display Name
                  </p>
                  <p className="text-xs text-on-surface-variant mt-0.5">
                    Visible to trip participants
                  </p>
                </div>
                <button
                  onClick={() => setEditingName(true)}
                  className="rounded-xl bg-surface-high px-3 py-2 text-sm text-on-surface transition-colors active:bg-surface-container"
                >
                  {profile?.display_name || "Set name"}
                </button>
              </div>

              <div className="h-px bg-surface-low" />

              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-on-surface">Email</p>
                  <p className="text-xs text-on-surface-variant mt-0.5">
                    From your sign-in provider
                  </p>
                </div>
                <span className="text-sm text-on-surface-variant">
                  {profile?.email || user.email || ""}
                </span>
              </div>
            </div>
          </section>

          {/* Preferences */}
          <section>
            <h3 className="text-xs font-semibold text-primary tracking-wide uppercase mb-4">
              Preferences
            </h3>
            <div className="rounded-2xl bg-surface-lowest p-5 shadow-soft space-y-5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-on-surface">
                    Location Sharing
                  </p>
                  <p className="text-xs text-on-surface-variant mt-0.5">
                    Share your location with trip members on the map
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={profile?.location_tracking_enabled ?? false}
                  onClick={handleToggleLocation}
                  disabled={savingLocation || loading}
                  className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full transition-colors disabled:opacity-40 ${profile?.location_tracking_enabled
                    ? "bg-primary"
                    : "bg-surface-high"
                    }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-on-primary shadow-soft transition-transform mt-1 ${profile?.location_tracking_enabled
                      ? "translate-x-6 ml-0.5"
                      : "translate-x-0.5"
                      }`}
                  />
                </button>
              </div>

              <div className="h-px bg-surface-low" />

              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-on-surface">
                    Usage Analytics
                  </p>
                  <p className="text-xs text-on-surface-variant mt-0.5">
                    Help improve the app by sharing anonymous usage data
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={profile?.analytics_enabled ?? true}
                  onClick={handleToggleAnalytics}
                  disabled={savingAnalytics || loading}
                  className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full transition-colors disabled:opacity-40 ${profile?.analytics_enabled ?? true
                    ? "bg-primary"
                    : "bg-surface-high"
                    }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-on-primary shadow-soft transition-transform mt-1 ${profile?.analytics_enabled ?? true
                      ? "translate-x-6 ml-0.5"
                      : "translate-x-0.5"
                      }`}
                  />
                </button>
              </div>
            </div>
          </section>

          {/* API Keys */}
          <section>
            <h3 className="text-xs font-semibold text-primary tracking-wide uppercase mb-4">
              API Keys
            </h3>
            <div className="rounded-2xl bg-surface-lowest p-5 shadow-soft space-y-4">
              <p className="text-xs text-on-surface-variant">
                Let your AI assistant (Claude, ChatGPT, or others) view and
                edit your trips directly.
              </p>

              {/* Created key alert — shown once */}
              {createdKeyValue && (
                <div className="rounded-xl bg-primary/10 p-4 space-y-2">
                  <p className="text-xs font-semibold text-primary">
                    Key created — copy it now. It won&apos;t be shown again.
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 rounded-lg bg-surface-high px-3 py-2 text-xs text-on-surface font-mono break-all select-all">
                      {createdKeyValue}
                    </code>
                    <button
                      onClick={handleCopyKey}
                      className="shrink-0 rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-on-primary transition-all active:scale-[0.98]"
                    >
                      {copiedKey ? "Copied!" : "Copy"}
                    </button>
                  </div>
                  <button
                    onClick={() => setCreatedKeyValue(null)}
                    className="text-xs text-on-surface-variant underline"
                  >
                    Dismiss
                  </button>
                </div>
              )}

              {/* Existing keys */}
              {loadingKeys ? (
                <div className="h-8 rounded bg-surface-high animate-pulse" />
              ) : apiKeys.length > 0 ? (
                <div className="space-y-3">
                  {apiKeys.map((key) => (
                    <div
                      key={key.id}
                      className="flex items-center justify-between gap-3 rounded-xl bg-surface-high p-3"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-on-surface truncate">
                          {key.name}
                        </p>
                        <p className="text-xs text-on-surface-variant font-mono">
                          {key.key_prefix}...
                        </p>
                      </div>
                      {confirmRevokeId === key.id ? (
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={() => handleRevokeKey(key.id)}
                            className="rounded-lg bg-error px-3 py-1.5 text-xs font-semibold text-on-primary"
                          >
                            Confirm
                          </button>
                          <button
                            onClick={() => setConfirmRevokeId(null)}
                            className="rounded-lg bg-surface-low px-3 py-1.5 text-xs text-on-surface-variant"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmRevokeId(key.id)}
                          className="shrink-0 rounded-lg bg-surface-low px-3 py-1.5 text-xs text-error transition-colors active:bg-surface-container"
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-on-surface-variant italic">
                  No API keys yet.
                </p>
              )}

              {/* Create key form */}
              {showKeyForm ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    placeholder="Key name (e.g., My laptop)"
                    maxLength={100}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCreateApiKey();
                      if (e.key === "Escape") {
                        setShowKeyForm(false);
                        setNewKeyName("");
                      }
                    }}
                    className="flex-1 rounded-xl bg-surface-high px-4 py-2.5 text-sm text-on-surface placeholder:text-outline focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  <button
                    onClick={handleCreateApiKey}
                    disabled={creatingKey || !newKeyName.trim()}
                    className="rounded-xl gradient-primary px-4 py-2.5 text-sm font-semibold text-on-primary shadow-soft transition-all active:scale-[0.98] disabled:opacity-40"
                  >
                    {creatingKey ? "..." : "Create"}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowKeyForm(true)}
                  className="w-full rounded-xl bg-surface-high px-4 py-3 text-sm font-medium text-primary transition-colors active:bg-surface-container"
                >
                  + Generate New Key
                </button>
              )}

              {/* Setup guide */}
              <div className="border-t border-outline/10 pt-3">
                <button
                  onClick={() => setShowSetupGuide(!showSetupGuide)}
                  className="flex w-full items-center justify-between text-xs font-medium text-on-surface-variant"
                >
                  <span>How to connect your AI assistant</span>
                  <svg
                    className={`h-4 w-4 transition-transform ${showSetupGuide ? "rotate-180" : ""}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {showSetupGuide && (
                  <div className="mt-3 space-y-3 text-xs text-on-surface-variant">
                    <p>
                      Your AI assistant needs two things to connect: the{" "}
                      <span className="font-medium text-on-surface">server address</span> and your{" "}
                      <span className="font-medium text-on-surface">API key</span>.
                    </p>

                    <ol className="list-decimal list-inside space-y-2 text-on-surface-variant">
                      <li>
                        <span className="font-medium text-on-surface">Generate a key</span> &mdash; tap &ldquo;Generate New Key&rdquo; above and copy it. You&apos;ll only see it once.
                      </li>
                      <li>
                        <span className="font-medium text-on-surface">Open your AI app&apos;s settings</span> &mdash; look for &ldquo;MCP Servers&rdquo;, &ldquo;Integrations&rdquo;, or &ldquo;Connections&rdquo;. (Check your app&apos;s docs if you&apos;re not sure where.)
                      </li>
                      <li>
                        <span className="font-medium text-on-surface">Add a new server</span> with these details:
                      </li>
                    </ol>

                    <div className="rounded-xl bg-surface-high p-4 space-y-2">
                      <div className="flex items-start gap-2">
                        <span className="shrink-0 font-medium text-on-surface">Server URL:</span>
                        <code className="font-mono text-on-surface break-all select-all">{`${process.env.NEXT_PUBLIC_MCP_SERVER_URL || "http://localhost:8080"}/mcp`}</code>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="shrink-0 font-medium text-on-surface">API Key:</span>
                        <span className="text-on-surface">paste the key you copied in step 1</span>
                      </div>
                    </div>

                    <p>
                      If your app asks for a config file instead, paste this (replacing{" "}
                      <code className="rounded bg-surface-high px-1 py-0.5 font-mono text-on-surface">YOUR_API_KEY</code>):
                    </p>
                    <pre className="overflow-x-auto rounded-xl bg-surface-high p-4 text-xs font-mono text-on-surface leading-relaxed select-all">
                      {`{
  "mcpServers": {
    "smart-travel-buddy": {
      "type": "http",
      "url": "${process.env.NEXT_PUBLIC_MCP_SERVER_URL || "http://localhost:8080"}/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}`}
                    </pre>

                    <ol start={4} className="list-decimal list-inside space-y-1.5 text-on-surface-variant">
                      <li>
                        <span className="font-medium text-on-surface">Restart your AI app</span> &mdash; it should now be able to see and edit your trips.
                      </li>
                    </ol>
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Sign Out */}
          <section>
            <button
              onClick={handleSignOut}
              className="w-full rounded-2xl bg-surface-lowest p-5 shadow-soft text-left transition-all active:scale-[0.98]"
            >
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-error/10 flex items-center justify-center">
                  <svg
                    className="h-5 w-5 text-error"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={2}
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9"
                    />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-semibold text-error">Sign Out</p>
                  <p className="text-xs text-on-surface-variant mt-0.5">
                    Sign out of your account
                  </p>
                </div>
              </div>
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}
