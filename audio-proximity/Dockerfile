# syntax=docker/dockerfile:1

ARG NODE_VERSION=22.14.0
ARG PNPM_VERSION=10.6.5

# ---- Base image with corepack and pnpm ----
FROM node:${NODE_VERSION} AS base
RUN --mount=type=cache,target=/root/.npm \
    npm install --global corepack@latest
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

# ---- Builder stage ----
FROM base AS builder
WORKDIR /app
COPY --link package.json pnpm-lock.yaml ./

# Set up pnpm cache
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV PNPM_STORE_DIR=/root/.pnpm-store

RUN --mount=type=cache,target=${PNPM_STORE_DIR} \
    pnpm install --frozen-lockfile

# Copy source and static files
COPY --link tsconfig.json ./
COPY --link src ./src
COPY --link static ./static

# Build TypeScript
RUN pnpm exec tsc

# ---- Production image ----
FROM node:${NODE_VERSION}-slim AS final
RUN --mount=type=cache,target=/root/.npm \
    npm install --global corepack@latest
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

# Security: create non-root user
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser

# Copy only necessary files and built output
COPY --from=builder --link /app/package.json ./
COPY --from=builder --link /app/node_modules ./node_modules
COPY --from=builder --link /app/build ./build
COPY --from=builder --link /app/static ./static

ENV NODE_ENV=production
USER appuser
EXPOSE 7733
CMD ["node", "build/index.js"]
