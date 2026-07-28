# ------------------------------------------------------------------------------
# 1) Builder Stage: builds TypeScript and compiles native modules
# ------------------------------------------------------------------------------
# Base version 24.18.0-alpine3.24; the digest is the authoritative build input.
FROM public.ecr.aws/docker/library/node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS builder

# Install build tools for native modules (sqlite3, etc.)
RUN apk add --no-cache g++ make python3

WORKDIR /app

# Copy only the manifest files first for better caching
COPY package*.json ./
COPY tsconfig.json ./
RUN npm ci --ignore-scripts \
 && npm rebuild better-sqlite3 sqlite3

# Copy the source needed for the build
COPY src ./src

# Build the TypeScript project
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts

# ------------------------------------------------------------------------------
# 2) Production Stage: minimal runtime image
# ------------------------------------------------------------------------------
FROM public.ecr.aws/docker/library/node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

# Strip npm from the runtime image: the app runs via `node` (see CMD) and
# node:24-alpine's bundled npm ships its own HIGH-CVE deps (picomatch/undici)
# that we don't need at runtime.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app

# Copy package files for reference
COPY --chown=root:root --chmod=0444 package*.json ./

# Copy the compiled TypeScript output
COPY --from=builder --chown=root:root --chmod=0555 /app/dist ./dist

# Copy production node_modules from the pruned builder (including the compiled
# native bindings, but excluding compilers, test runners, and other dev tools).
COPY --from=builder --chown=root:root --chmod=0555 /app/node_modules ./node_modules

# Expose port
EXPOSE 8080

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "const port=process.env.PORT||'8080';fetch(`http://127.0.0.1:${port}/info`).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

# Start command — preload the OpenTelemetry bootstrap so auto-instrumentation
# patches modules before app code is imported.
CMD ["node", "--require", "./dist/telemetry.js", "dist/server.js"]
