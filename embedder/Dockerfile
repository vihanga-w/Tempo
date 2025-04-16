# syntax=docker/dockerfile:1

# Stage 1: Base image with Node.js and pnpm setup
ARG NODE_VERSION=22.14.0
ARG PNPM_VERSION=10.4.1
FROM node:${NODE_VERSION} AS base

# Update Corepack and enable pnpm
RUN --mount=type=cache,target=/root/.npm \
    npm install --global corepack@latest && \
    corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app

# Stage 2: Builder stage for dependencies and build
FROM base AS builder

# Set up pnpm cache directory
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV PNPM_STORE_DIR=/root/.pnpm-store

# Copy package manager files and install dependencies
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,target=${PNPM_STORE_DIR} \
    pnpm install --no-frozen-lockfile --force

# Copy source files and build the project
COPY tsconfig.json ./
COPY src ./src
COPY keys ./keys

RUN pnpm run build

# Stage 3: Production image
FROM node:${NODE_VERSION}-slim AS final

# Enable pnpm in the production image
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app

# Set environment to production
ENV NODE_ENV=production

# Copy only necessary files from the builder stage
COPY --from=builder /app/build ./build
COPY --from=builder /app/package.json ./
# COPY --from=builder /app/.vapid ./
# COPY --from=builder /app/data ./data
# COPY --from=builder /app/embeddings ./embeddings
COPY --from=builder /app/keys ./keys
# COPY --from=builder /app/notify ./notify
# COPY --from=builder /app/recaps ./recaps
# COPY --from=builder /app/song-data-cache ./song-data-cache
# COPY --from=builder /app/tempo-embeddings.acebase ./tempo-embeddings.acebase
# COPY --from=builder /app/tempo-friends.acebase ./tempo-friends.acebase
# COPY --from=builder /app/tempo-main.acebase ./tempo-main.acebase
# COPY --from=builder /app/tempo-tastes.acebase ./tempo-tastes.acebase
# COPY --from=builder /app/tempo-users.acebase ./tempo-users.acebase
COPY --from=builder /app/node_modules ./node_modules

# Expose the application port
EXPOSE 2246

# Define the command to run the application
CMD ["node", "./build/spotify.js"]