#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Smart Travel Buddy — Cloud Run Deployment Script
# Usage: ./deploy/deploy.sh [setup|all|frontend|backend|mcpserver]
#
# Variables: set via deploy/.env (local) or environment variables (CI/CD).
# See deploy/.env.example for the full list.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# Load from deploy/.env if present; pre-set env vars take priority
if [[ -f "${SCRIPT_DIR}/.env" ]]; then
  set -a
  # shellcheck source=deploy/.env
  source "${SCRIPT_DIR}/.env"
  set +a
fi

# --- Required variables -------------------------------------------------------
required_vars=(
  PROJECT_ID REGION AR_REPO
  FRONTEND_SERVICE BACKEND_SERVICE MCPSERVER_SERVICE
  GCS_CHAT_HISTORY_BUCKET
  GOOGLE_MAPS_API_KEY_SERVER GOOGLE_MAPS_API_KEY_CLIENT
  API_KEY_HMAC_SECRET
  NEXT_PUBLIC_FIREBASE_API_KEY
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
  NEXT_PUBLIC_FIREBASE_PROJECT_ID
)
for v in "${required_vars[@]}"; do
  [[ -n "${!v:-}" ]] || {
    echo "ERROR: \$${v} is not set."
    echo "  Copy deploy/.env.example to deploy/.env and fill it in,"
    echo "  or set the variable in your environment (CI: use repository secrets)."
    exit 1
  }
done

# --- Derived config -----------------------------------------------------------
AR_HOST="${REGION}-docker.pkg.dev"
AR_PREFIX="${AR_HOST}/${PROJECT_ID}/${AR_REPO}"
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY="${GOOGLE_MAPS_API_KEY_CLIENT}"

# --- Defaults with env override -----------------------------------------------
GOOGLE_CLOUD_LOCATION="${GOOGLE_CLOUD_LOCATION:-global}"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-3-flash-preview}"
MCP_SERVER_URL="${MCP_SERVER_URL:-}"

TARGET="${1:-all}"

# --- Helpers -----------------------------------------------------------------

log() { echo "==> $*"; }
err() { echo "ERROR: $*" >&2; exit 1; }

get_service_url() {
  # status.url only returns the legacy hash-based URL; the urls annotation has all URLs.
  # Return the first URL from the annotation (the canonical/new one), fall back to status.url.
  local raw
  raw="$(gcloud run services describe "$1" \
    --project="$PROJECT_ID" --region="$REGION" \
    --format='value(metadata.annotations["run.googleapis.com/urls"])' 2>/dev/null)" || true
  if [[ -n "$raw" ]]; then
    echo "$raw" | tr -d '[] ' | tr '"' '\n' | grep -m1 '^https://'
  else
    gcloud run services describe "$1" \
      --project="$PROJECT_ID" --region="$REGION" \
      --format='value(status.url)' 2>/dev/null || echo ""
  fi
}

# Returns all URLs for a service as comma-separated string — use this for CORS_ORIGINS.
get_service_cors_origins() {
  local raw
  raw="$(gcloud run services describe "$1" \
    --project="$PROJECT_ID" --region="$REGION" \
    --format='value(metadata.annotations["run.googleapis.com/urls"])' 2>/dev/null)" || true
  if [[ -n "$raw" ]]; then
    echo "$raw" | tr -d '[] ' | tr '"' '\n' | grep '^https://' | paste -sd ',' -
  else
    get_service_url "$1"
  fi
}

image_tag() {
  local service="$1"
  local sha
  sha="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  echo "${AR_PREFIX}/${service}:${sha}"
}

set_public_access() {
  local service="$1"
  if ! gcloud run services add-iam-policy-binding "$service" \
      --project="$PROJECT_ID" --region="$REGION" \
      --member="allUsers" \
      --role="roles/run.invoker" \
      --quiet 2>/dev/null; then
    echo "WARNING: Could not set public access on ${service}."
    echo "  The service requires roles/run.admin or roles/owner."
    echo "  Grant it via the GCP Console or run:"
    echo "    gcloud projects add-iam-policy-binding ${PROJECT_ID} --member=user:YOUR_EMAIL --role=roles/run.admin"
    echo "  Then re-run: ./deploy/deploy.sh ${service##smart-travel-buddy-}"
  fi
}

cleanup_old_revisions() {
  local service="$1"
  local max_keep=3
  local revisions
  revisions="$(gcloud run revisions list \
    --service="$service" \
    --project="$PROJECT_ID" --region="$REGION" \
    --sort-by="~metadata.creationTimestamp" \
    --format='value(metadata.name)' 2>/dev/null)" || return 0

  local count=0
  while IFS= read -r rev; do
    [[ -z "$rev" ]] && continue
    count=$((count + 1))
    if [[ $count -gt $max_keep ]]; then
      log "Deleting old revision: $rev"
      gcloud run revisions delete "$rev" \
        --project="$PROJECT_ID" --region="$REGION" \
        --quiet 2>/dev/null || true
    fi
  done <<< "$revisions"
}

ensure_ar_repo() {
  if ! gcloud artifacts repositories describe "$AR_REPO" \
      --project="$PROJECT_ID" --location="$REGION" &>/dev/null; then
    log "Creating Artifact Registry repository: $AR_REPO"
    gcloud artifacts repositories create "$AR_REPO" \
      --project="$PROJECT_ID" --location="$REGION" \
      --repository-format=docker
  fi
}

# --- Setup (one-time) -------------------------------------------------------

do_setup() {
  log "Running one-time setup..."

  # Artifact Registry
  ensure_ar_repo

  log "Setup complete."
}

# --- Deploy Backend ----------------------------------------------------------

deploy_backend() {
  log "Deploying backend..."

  local tag
  tag="$(image_tag "$BACKEND_SERVICE")"

  local cors
  cors="$(get_service_cors_origins "$FRONTEND_SERVICE")"
  cors="${cors:-http://localhost:3000}"

  gcloud builds submit "$REPO_ROOT" \
    --project="$PROJECT_ID" \
    --config=deploy/cloudbuild-backend.yaml \
    --substitutions="_TAG=${tag}" \
    --quiet

  gcloud run deploy "$BACKEND_SERVICE" \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --image="$tag" \
    --platform=managed \
    --allow-unauthenticated \
    --memory=1Gi --cpu=1 \
    --min-instances=0 --max-instances=2 \
    --concurrency=80 \
    --timeout=300 \
    --no-cpu-throttling \
    --set-env-vars="^|^GOOGLE_CLOUD_PROJECT=${PROJECT_ID}|GOOGLE_CLOUD_LOCATION=${GOOGLE_CLOUD_LOCATION}|CORS_ORIGINS=${cors}|GCS_CHAT_HISTORY_BUCKET=${GCS_CHAT_HISTORY_BUCKET}|GEMINI_MODEL=${GEMINI_MODEL}|GOOGLE_MAPS_API_KEY=${GOOGLE_MAPS_API_KEY_SERVER}|API_KEY_HMAC_SECRET=${API_KEY_HMAC_SECRET}" \
    --quiet
  set_public_access "$BACKEND_SERVICE"

  local backend_url
  backend_url="$(get_service_url "$BACKEND_SERVICE")"
  cleanup_old_revisions "$BACKEND_SERVICE"
  log "Backend deployed: ${backend_url}"

  # If frontend is already deployed, ensure CORS includes all its URLs
  if [[ "$cors" == "http://localhost:3000" ]]; then
    local actual_cors
    actual_cors="$(get_service_cors_origins "$FRONTEND_SERVICE")"
    if [[ -n "$actual_cors" ]]; then
      log "Updating CORS_ORIGINS to include frontend: ${actual_cors}"
      gcloud run services update "$BACKEND_SERVICE" \
        --project="$PROJECT_ID" --region="$REGION" \
        --update-env-vars="^|^CORS_ORIGINS=${actual_cors}" \
        --quiet
    fi
  fi
}

# --- Deploy Frontend ---------------------------------------------------------

deploy_frontend() {
  log "Deploying frontend..."

  local backend_url
  backend_url="$(get_service_url "$BACKEND_SERVICE")"
  if [[ -z "$backend_url" ]]; then
    err "Backend must be deployed first (frontend needs NEXT_PUBLIC_BACKEND_URL at build time)"
  fi

  local tag
  tag="$(image_tag "$FRONTEND_SERVICE")"

  # Resolve MCP server URL for frontend instructions display
  local mcp_url="${MCP_SERVER_URL:-}"
  if [[ -z "$mcp_url" ]]; then
    mcp_url="$(get_service_url "$MCPSERVER_SERVICE")"
  fi
  mcp_url="${mcp_url:-}"

  gcloud builds submit "$REPO_ROOT" \
    --project="$PROJECT_ID" \
    --config=deploy/cloudbuild-frontend.yaml \
    --substitutions="_TAG=${tag},_NEXT_PUBLIC_FIREBASE_API_KEY=${NEXT_PUBLIC_FIREBASE_API_KEY},_NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=${NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN},_NEXT_PUBLIC_FIREBASE_PROJECT_ID=${NEXT_PUBLIC_FIREBASE_PROJECT_ID},_NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=${NEXT_PUBLIC_GOOGLE_MAPS_API_KEY},_NEXT_PUBLIC_BACKEND_URL=${backend_url},_NEXT_PUBLIC_MCP_SERVER_URL=${mcp_url}" \
    --quiet

  gcloud run deploy "$FRONTEND_SERVICE" \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --image="$tag" \
    --platform=managed \
    --allow-unauthenticated \
    --memory=512Mi --cpu=1 \
    --min-instances=0 --max-instances=1 \
    --concurrency=80 \
    --timeout=60 \
    --quiet
  set_public_access "$FRONTEND_SERVICE"

  cleanup_old_revisions "$FRONTEND_SERVICE"
  log "Frontend deployed: $(get_service_url "$FRONTEND_SERVICE")"

  # Always sync backend CORS_ORIGINS to all actual frontend URLs
  local actual_cors
  actual_cors="$(get_service_cors_origins "$FRONTEND_SERVICE")"
  if [[ -n "$actual_cors" ]]; then
    log "Updating backend CORS_ORIGINS to ${actual_cors}"
    gcloud run services update "$BACKEND_SERVICE" \
      --project="$PROJECT_ID" --region="$REGION" \
      --update-env-vars="^|^CORS_ORIGINS=${actual_cors}" \
      --quiet
  fi
}

# --- Deploy MCP Server ------------------------------------------------------

deploy_mcpserver() {
  if [[ ! -f "${REPO_ROOT}/mcpserver/src/main.py" ]]; then
    log "SKIP: mcpserver/src/main.py not found — skeleton service, skipping."
    return 0
  fi

  log "Deploying MCP server..."

  local tag
  tag="$(image_tag "$MCPSERVER_SERVICE")"

  gcloud builds submit "$REPO_ROOT" \
    --project="$PROJECT_ID" \
    --config=deploy/cloudbuild-mcpserver.yaml \
    --substitutions="_TAG=${tag}" \
    --quiet

  gcloud run deploy "$MCPSERVER_SERVICE" \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --image="$tag" \
    --platform=managed \
    --allow-unauthenticated \
    --memory=512Mi --cpu=1 \
    --min-instances=0 --max-instances=2 \
    --concurrency=40 \
    --timeout=300 \
    --no-cpu-throttling \
    --set-env-vars="GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GOOGLE_MAPS_API_KEY=${GOOGLE_MAPS_API_KEY_SERVER},API_KEY_HMAC_SECRET=${API_KEY_HMAC_SECRET}" \
    --quiet
  set_public_access "$MCPSERVER_SERVICE"

  cleanup_old_revisions "$MCPSERVER_SERVICE"
  log "MCP server deployed: $(get_service_url "$MCPSERVER_SERVICE")"
}

# --- Orchestration -----------------------------------------------------------

cd "$REPO_ROOT"

case "$TARGET" in
  setup)
    do_setup
    ;;
  backend)
    ensure_ar_repo
    deploy_backend
    ;;
  frontend)
    ensure_ar_repo
    deploy_frontend
    ;;
  mcpserver)
    ensure_ar_repo
    deploy_mcpserver
    ;;
  all)
    ensure_ar_repo
    deploy_backend
    deploy_frontend

    # deploy_frontend already updated CORS; this is a no-op safety net for the all target

    deploy_mcpserver
    log "All services deployed."
    ;;
  *)
    echo "Usage: $0 [setup|all|frontend|backend|mcpserver]"
    exit 1
    ;;
esac
