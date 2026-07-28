# Build stage
# Base version 24.18.0-alpine3.24; the digest is the authoritative build input.
FROM node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS builder

WORKDIR /app

# better-sqlite3 (transitive via @bsv/wallet-toolbox) ships no musl prebuilt for
# Node 24 — needs python3/make/g++ to compile from source on Alpine.
RUN apk add --no-cache g++ make python3

# Copy package files
COPY package*.json ./

# Install without running arbitrary dependency lifecycle scripts, then compile
# the one allowlisted native module required by the service.
RUN npm ci --ignore-scripts \
 && npm rebuild better-sqlite3

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Production stage
FROM node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

WORKDIR /app

# Install better-sqlite3 native build tools (see builder stage). The pinned
# base is refreshed by reviewed Dependabot changes instead of mutating it with
# a time-dependent apk upgrade. The toolchain is removed after npm ci below.
RUN apk add --no-cache --virtual .build-deps g++ make python3

# Copy package files
COPY package*.json ./

# Install production dependencies only. Then strip npm from the runtime image:
# the app runs via `node` (see CMD) and node:24-alpine's bundled npm ships its
# own HIGH-CVE deps (tar/glob/minimatch/cross-spawn/undici) that we don't need.
RUN npm ci --omit=dev --ignore-scripts \
 && npm rebuild better-sqlite3 \
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

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "const port=process.env.PORT||'3011';fetch('http://127.0.0.1:'+port+'/getInfo').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

# Run the application with the OpenTelemetry bootstrap preloaded so
# auto-instrumentation patches modules before app code is imported.
CMD ["node", "--require", "./dist/telemetry.js", "dist/server.js"]
