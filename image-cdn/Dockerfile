# syntax=docker/dockerfile:1

# Define build arguments for Node.js version
ARG NODE_VERSION=22.14.0

# Separate stage for building ImageMagick
FROM node:${NODE_VERSION} AS imagemagick

# Install dependencies for building ImageMagick
RUN apt-get update && apt-get install -y \
    build-essential \
    wget \
    libjpeg-dev \
    libpng-dev \
    libtiff-dev \
    libwebp-dev \
    libtool \
    libltdl-dev \
    liblcms2-dev \
    && rm -rf /var/lib/apt/lists/*

# Download and build the latest ImageMagick from source
RUN wget https://download.imagemagick.org/ImageMagick/download/ImageMagick.tar.gz && \
    tar -xzf ImageMagick.tar.gz && \
    cd ImageMagick-* && \
    ./configure --with-webp=yes && \
    make && \
    make install && \
    ldconfig && \
    cd .. && \
    rm -rf ImageMagick* && \
    rm -rf /var/lib/apt/lists/*

# Base image for development and building
FROM node:${NODE_VERSION} AS base

# Copy ImageMagick binaries from the imagemagick stage
COPY --from=imagemagick /usr/local /usr/local

# Install dependencies for building the application
RUN apt-get update && apt-get install -y \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

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

# Copy ImageMagick binaries from the imagemagick stage
COPY --from=imagemagick /usr/local /usr/local

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    libjpeg62-turbo \
    libpng16-16 \
    libtiff5-dev \
    libwebp-dev \
    liblcms2-dev \
    && rm -rf /var/lib/apt/lists/*

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