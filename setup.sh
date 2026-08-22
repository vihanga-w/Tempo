#!/usr/bin/env bash
#
# Tempo deployment script.
#
#   Run from /root, with a .env alongside it:
#
#       cd /root && ./setup.sh
#
# Works on a bare VPS: installs Docker if missing, clones the repository to
# /tempo, and brings the API up. Re-running it updates to the latest commit and
# restarts — so it is both the installer and the deploy command.
#
# The .env in the directory you run it from is the source of truth. It is copied
# into the deployment on every run, so the repository never has to carry it and
# a redeploy cannot lose it.
#
# Requires GH_TOKEN in that .env for a private repository.

set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/tempo}"
REPO_SLUG="${REPO_SLUG:-vihanga-w/Tempo}"
BRANCH="${BRANCH:-main}"
SERVICE_DIR="embedder"

RUN_FROM="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ENV="${RUN_FROM}/.env"

log()  { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[1;31mError:\033[0m %s\n\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight --

[ "$(id -u)" -eq 0 ] || die "Run as root (installs packages and manages Docker)."

[ -f "$SOURCE_ENV" ] || die "No .env found at ${SOURCE_ENV}
    Copy ${SERVICE_DIR}/.env.example there and fill it in first."

# Read GH_TOKEN without sourcing the file — .env values are not shell-safe
GH_TOKEN="$(grep -E '^GH_TOKEN=' "$SOURCE_ENV" | head -1 | cut -d= -f2- | tr -d '"'\''' || true)"

[ -n "${GH_TOKEN:-}" ] || die "GH_TOKEN is not set in ${SOURCE_ENV}
    Needs a token with read access to ${REPO_SLUG}."

# A dev value here makes the container write into its own writable layer instead
# of the mounted volume, silently discarding data on every redeploy
if grep -qE '^TEMPO_DATA_DIR=' "$SOURCE_ENV"; then
    info "Note: TEMPO_DATA_DIR in .env is ignored — compose pins it to /tempodb."
fi

# ------------------------------------------------------------------ docker --

if ! command -v docker >/dev/null 2>&1; then
    log "Installing Docker"

    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl git

    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc

    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" \
        > /etc/apt/sources.list.d/docker.list

    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

    systemctl enable --now docker
else
    info "Docker present: $(docker --version)"
fi

command -v git >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq git; }

docker compose version >/dev/null 2>&1 || die "docker compose plugin is missing."

# ------------------------------------------------------------------- source --

REPO_URL="https://x-access-token:${GH_TOKEN}@github.com/${REPO_SLUG}.git"

if [ -d "${INSTALL_DIR}/.git" ]; then
    log "Updating ${INSTALL_DIR}"

    cd "$INSTALL_DIR"

    # The token can change between runs, so always reset the remote
    git remote set-url origin "$REPO_URL"
    git fetch --quiet origin "$BRANCH"

    # Deployments are disposable: take the remote verbatim rather than trying to
    # merge whatever might have been edited on the box
    git reset --hard --quiet "origin/${BRANCH}"
    git clean -fd --quiet -e .env

    info "At $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"
else
    log "Cloning ${REPO_SLUG} into ${INSTALL_DIR}"

    rm -rf "$INSTALL_DIR"
    git clone --quiet --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"

    cd "$INSTALL_DIR"
    info "At $(git rev-parse --short HEAD)"
fi

# Strip the token back out so it is not left sitting in .git/config
git remote set-url origin "https://github.com/${REPO_SLUG}.git"

# --------------------------------------------------------------------- env --

log "Installing environment"

cp "$SOURCE_ENV" "${INSTALL_DIR}/${SERVICE_DIR}/.env"
chmod 600 "${INSTALL_DIR}/${SERVICE_DIR}/.env"

info "Copied ${SOURCE_ENV} -> ${SERVICE_DIR}/.env"

# ------------------------------------------------------------------ deploy --

cd "${INSTALL_DIR}/${SERVICE_DIR}"

log "Building"
docker compose build

log "Starting"
docker compose up -d --remove-orphans

# Reclaim space from superseded images; without this a VPS fills up after a
# handful of deploys
docker image prune -f >/dev/null 2>&1 || true

# ------------------------------------------------------------------ verify --

log "Waiting for health"

for i in $(seq 1 30); do
    status="$(docker compose ps --format json 2>/dev/null | grep -o '"Health":"[a-z]*"' | head -1 | cut -d'"' -f4 || true)"

    if [ "$status" = "healthy" ]; then
        info "Healthy after ${i}0s"
        break
    fi

    if [ "$i" -eq 30 ]; then
        printf '\n\033[1;31mDid not become healthy.\033[0m Recent logs:\n\n'
        docker compose logs --tail 40
        exit 1
    fi

    sleep 10
done

log "Deployed"
info "Listening on port 80"
info "Logs:    cd ${INSTALL_DIR}/${SERVICE_DIR} && docker compose logs -f"
info "Restart: cd ${INSTALL_DIR}/${SERVICE_DIR} && docker compose restart"
info "Update:  ${RUN_FROM}/setup.sh"
printf '\n'
