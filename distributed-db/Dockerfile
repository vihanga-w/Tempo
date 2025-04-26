# syntax=docker/dockerfile:1

# Define build arguments
ARG NODE_VERSION=22.14.0
ARG PNPM_VERSION=10.6.5

FROM node:${NODE_VERSION} AS base

# Corepack + pnpm
RUN --mount=type=cache,target=/root/.npm \
    npm install --global corepack@latest && \
    corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app

FROM base AS builder

COPY --link package.json pnpm-lock.yaml ./

ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV PNPM_STORE_DIR=/root/.pnpm-store

RUN --mount=type=cache,target=${PNPM_STORE_DIR} \
    pnpm install --no-frozen-lockfile --force

COPY --link tsconfig.json ./
COPY --link src ./src
COPY --link trusted-keys ./trusted-keys
COPY --link keys ./keys

RUN pnpm run build

FROM node:${NODE_VERSION}-slim AS final

RUN --mount=type=cache,target=/root/.npm \
    npm install --global corepack@latest && \
    corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app

COPY --from=builder /app/build ./build
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/trusted-keys ./trusted-keys
COPY --from=builder /app/keys ./keys

ENV NODE_ENV=production

# Expose INTERNAL DB API port (5000)
EXPOSE 5000

# Default command
CMD ["node", "./build/index.js"]
