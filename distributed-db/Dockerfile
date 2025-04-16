# syntax=docker/dockerfile:1

# Define build arguments for Node.js and pnpm versions
ARG NODE_VERSION=22.14.0
ARG PNPM_VERSION=10.6.5

# Base image for development and building
FROM node:${NODE_VERSION} AS base

# Update Corepack and enable pnpm
RUN --mount=type=cache,target=/root/.npm \
    npm install --global corepack@latest && \
    corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Set working directory
WORKDIR /app

# Builder stage for dependencies and compilation
FROM base AS builder

# Copy package manager files
COPY --link package.json pnpm-lock.yaml ./

# Install dependencies
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV PNPM_STORE_DIR=/root/.pnpm-store
RUN --mount=type=cache,target=${PNPM_STORE_DIR} \
    pnpm install --frozen-lockfile

# Copy source files and compile TypeScript
COPY --link tsconfig.json ./
COPY --link src ./src
COPY --link trusted-keys ./trusted-keys
RUN pnpm run build

# Production stage with minimal image
FROM node:${NODE_VERSION}-slim AS final

# Enable pnpm
RUN --mount=type=cache,target=/root/.npm \
    npm install --global corepack@latest && \
    corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Set working directory
WORKDIR /app

# Copy necessary files from builder stage
COPY --from=builder /app/build ./build
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/trusted-keys ./trusted-keys

# Set environment variables
ENV NODE_ENV=production

# Expose application port
EXPOSE 2275

# Define the command to run the application
CMD ["node", "./build/index.js"]