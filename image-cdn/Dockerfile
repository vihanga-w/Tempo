# syntax=docker/dockerfile:1

# Define build arguments for Node.js version
ARG NODE_VERSION=22.14.0

# Base image for development and building
FROM node:${NODE_VERSION} AS base

# Update Corepack and enable npm
RUN --mount=type=cache,target=/root/.npm \
    npm install --global corepack@latest

# Install ImageMagick
RUN apt-get update && apt-get install -y imagemagick && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Builder stage for dependencies and compilation
FROM base AS builder

# Copy package manager files
COPY package.json ./

# Install dependencies using npm
RUN --mount=type=cache,target=/root/.npm \
    npm i

# Copy source files and compile TypeScript
COPY ./src ./src
COPY ./tsconfig.json ./
RUN npm run build

# Production stage with minimal image
FROM node:${NODE_VERSION}-slim AS final

# Update Corepack and enable npm
RUN --mount=type=cache,target=/root/.npm \
    npm install --global corepack@latest

# Set working directory
WORKDIR /app

# Copy necessary files from builder stage
COPY --from=builder /app/build ./build
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules

# Set environment variables
ENV NODE_ENV=production

# Expose application port
EXPOSE 2283

# Define the command to run the application
CMD ["node", "./build/index.js"]