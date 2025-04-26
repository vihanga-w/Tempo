FROM node:22.14.0-slim

WORKDIR /proxy

# Install minimal dependencies
COPY package.json ./
RUN npm install

# Copy proxy entrypoint and proxy class
COPY proxy.js ./proxy.js
COPY src/transparent-proxy.ts ./transparent-proxy.ts

ENV NODE_ENV=production

EXPOSE 2275

CMD ["node", "proxy.js"]