# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# better-sqlite3 (transitive via @bsv/wallet-toolbox) ships no musl prebuilt for
# node 20 — needs python3/make/g++ to compile from source on Alpine.
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Patch OS openssl libs (CVE-2026-45447) and install better-sqlite3 native build
# tools (see builder stage). Upgrade and add toolchain in one layer; the toolchain
# is removed after npm ci below to keep the image slim.
RUN apk upgrade --no-cache libssl3 libcrypto3 \
 && apk add --no-cache --virtual .build-deps python3 make g++

# Copy package files
COPY package*.json ./

# Install production dependencies only. Then strip npm from the runtime image:
# the app runs via `node` (see CMD) and node:20-alpine's bundled npm ships its
# own HIGH-CVE deps (tar/glob/minimatch/cross-spawn/undici) that we don't need.
RUN npm ci --omit=dev \
 && apk del .build-deps \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Copy built application from builder
COPY --from=builder /app/dist ./dist

# Create directory for bulk headers and give the non-root node user ownership
RUN mkdir -p /app/public/headers && chown -R node:node /app

# Drop privileges before running the service
USER node

# Expose ports
# 3011 - ChaintracksService
# 3012 - CDN Server (bulk headers)
EXPOSE 3011 3012

# Run the application with the OpenTelemetry bootstrap preloaded so
# auto-instrumentation patches modules before app code is imported.
CMD ["node", "--require", "./dist/telemetry.js", "dist/server.js"]
