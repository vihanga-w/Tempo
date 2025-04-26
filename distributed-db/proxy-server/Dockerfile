# syntax=docker/dockerfile:1

FROM node:22.14.0-slim

WORKDIR /proxy

# Copy built node_modules and package.json from local build
COPY ../node_modules ./node_modules
COPY ../package.json ./package.json

# Copy built Transparent Proxy output and proxy script
COPY ../build/src/proxy/transparent-proxy.js ./transparent-proxy.js
COPY proxy.js ./proxy.js

ENV NODE_ENV=production
ENV LEADER_DISCOVERY_URL=http://leader-discovery:5000

EXPOSE 2275

CMD ["node", "proxy.js"]