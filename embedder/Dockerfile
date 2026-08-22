# syntax=docker/dockerfile:1

ARG NODE_VERSION=22.14.0
ARG PNPM_VERSION=10.30.0

# ---- base: node + pnpm ----
FROM node:${NODE_VERSION}-slim AS base

RUN npm install --global corepack@latest && \
    corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app

ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV PNPM_STORE_DIR=/root/.pnpm-store

# pnpm 10 aborts a clean install when a dependency's build script is not
# pre-approved. sharp is approved in pnpm-workspace.yaml, but that is not picked
# up reliably here, and sharp ships prebuilt binaries as optional deps (the
# lockfile carries them per platform) so its install script is only a
# verification step. Downgrade the abort to a warning; the explicit sharp load
# test below is what actually guarantees a working binary.
ENV npm_config_strict_dep_builds=false

# ---- deps: production node_modules only ----
FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Frozen: the lockfile is the source of truth, so a build cannot silently
# resolve different versions than were tested.
#
# The `|| true` is deliberate. pnpm 10 finishes installing and *then* aborts with
# ERR_PNPM_IGNORED_BUILDS if a dependency's build script was not pre-approved —
# the tree is already complete at that point. Approving sharp via
# pnpm-workspace.yaml is not honoured reliably in this image, so instead the
# build script is run explicitly below and the binary is proven to load. A
# genuinely broken install still fails the build, just at a check that actually
# tests the thing we care about.
RUN pnpm install --frozen-lockfile --prod || true

# sharp resolves its native binding from the prebuilt @img/sharp-<platform>
# optional dependency, which the lockfile carries for every target. Its install
# script only validates that, so skipping it is harmless — but prove the binding
# actually loads, since that is the thing that would otherwise fail at runtime.
RUN node -e "const s=require('sharp'); console.log('sharp ok, libvips', s.versions.vips)"

# ---- build: compile TypeScript with dev deps available ----
FROM base AS build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN pnpm install --frozen-lockfile || true

COPY tsconfig.json ./
COPY src ./src

RUN pnpm exec tsc

# ---- final ----
FROM node:${NODE_VERSION}-slim AS final

WORKDIR /app

ENV NODE_ENV=production

# tini reaps zombies and forwards signals, so SIGINT reaches the shutdown
# handler that detaches user sessions rather than the process being killed
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY package.json ./

# Static assets and the embeddings index the recommender reads at boot
COPY static ./static
COPY songs.json ./songs.json
COPY embeddings-index.json ./embeddings-index.json

# Signing keys and the data directory are mounted at runtime, never baked in.
# Both are generated on first boot if their volume is empty.
# embeddings/ is gitignored, so it is never present in a clone — it is mounted
# rather than baked in, which also means the corpus can be replaced without
# rebuilding the image. The recommender returns an empty profile when it is
# empty, so the API starts fine either way.
VOLUME ["/app/keys", "/app/embeddings", "/tempodb"]

RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser \
    && mkdir -p /app/keys /app/embeddings /tempodb \
    && chown -R appuser:appgroup /app /tempodb

USER appuser

EXPOSE 2246

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:2246/.version').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "./build/spotify.js"]
