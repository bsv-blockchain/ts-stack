# ---- Build stage ----
# Base version 24.18.0-alpine3.24; the digest is the authoritative build input.
FROM node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS builder

WORKDIR /app

# Native deps (better-sqlite3) compile from source on Alpine (musl, no prebuilt
# binaries) — needs python3/make/g++.
RUN apk add --no-cache g++ make python3

# Copy package files first for better layer caching
COPY package*.json ./
COPY tsconfig*.json ./
COPY knexfile.ts ./

# Install without running arbitrary dependency lifecycle scripts, then compile
# the one allowlisted native module required by the service.
RUN npm ci --ignore-scripts \
 && npm rebuild better-sqlite3

# Copy source code required for compilation
COPY src ./src

# Build the TypeScript project
RUN npm run build

# Copy compiled knexfile.js to /app root (where imports like '../../knexfile.js' expect it)
RUN cp out/knexfile.js ./knexfile.js

# ---- Production stage ----
FROM node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

WORKDIR /app

# Copy package files and install production deps only.
# better-sqlite3 compiles from source on Alpine; add the toolchain just for the
# install, then remove it in the same layer to keep the image slim.
COPY --chown=root:root --chmod=0444 package*.json ./
RUN apk add --no-cache --virtual .build-deps g++ make python3 \
 && npm ci --omit=dev --ignore-scripts \
 && npm rebuild better-sqlite3 \
 && apk del .build-deps \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Copy built output from builder
COPY --from=builder --chown=root:root --chmod=0555 /app/out ./out
COPY --from=builder --chown=root:root --chmod=0444 /app/knexfile.js ./knexfile.js

# The Node process serves HTTP and WebSocket traffic directly. Operators can
# place a platform/load-balancer proxy in front of the container.
EXPOSE 8080

USER node

# Start the app with the OpenTelemetry bootstrap preloaded (ESM --import) so
# auto-instrumentation patches modules before they are imported.
CMD [ "node", "--import", "./out/src/telemetry.js", "out/src/index.js" ]
