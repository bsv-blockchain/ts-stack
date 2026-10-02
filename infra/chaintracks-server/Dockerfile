# Build stage
# Base version 24.20.0-alpine3.24; the digest is the authoritative build input.
FROM node@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS builder

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
FROM node@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

WORKDIR /app

# Install better-sqlite3 native build tools (see builder stage). Install the
# reviewed Alpine libcrypto3/libssl3 3.5.9-r0 pin for CVE-2026-84782 alongside
# the disposable toolchain. The toolchain is removed after npm ci below while
# the pinned runtime libraries remain.
RUN apk add --no-cache --virtual .build-deps g++ make python3 \
 && apk add --no-cache libcrypto3=3.5.9-r0 libssl3=3.5.9-r0

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

# Keep first-party and incorporated-material terms with the deployed image.
COPY LICENSE.txt THIRD_PARTY_NOTICES.md /usr/share/licenses/ts-stack/
COPY LICENSES /usr/share/licenses/ts-stack/LICENSES
RUN chmod -R a=rX /usr/share/licenses/ts-stack
LABEL org.bsvblockchain.license.notice="/usr/share/licenses/ts-stack/THIRD_PARTY_NOTICES.md"

# Create directory for bulk headers and give the non-root node user ownership
RUN mkdir -p /app/public/headers && chown -R node:node /app

# Drop privileges before running the service
USER node

# Expose ports
# 3011 - ChaintracksService
# 3012 - CDN Server (bulk headers)
EXPOSE 3011 3012

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "const port=process.env.PORT||'3011';const prefix=(process.env.ROUTING_PREFIX||'').replace(/\\/+$/,'');fetch('http://127.0.0.1:'+port+prefix+'/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

# Run the application with the OpenTelemetry bootstrap preloaded so
# auto-instrumentation patches modules before app code is imported.
CMD ["node", "--require", "./dist/telemetry.js", "dist/server.js"]
