FROM node:22.14.0-slim

WORKDIR /proxy

# Install dependencies
COPY package.json tsconfig.json ./
RUN npm install

# Copy source
COPY src ./src

# Build the TypeScript project
RUN npm run build

# Expose proxy listen port
EXPOSE 2276

# Start proxy
CMD ["npm", "start"]