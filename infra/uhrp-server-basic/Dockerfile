# ── Stage 1: build ──────────────────────────────────────────
# Base version 24.18.0-alpine3.24; the digest is the authoritative build input.
FROM node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build
RUN npm ci --omit=dev --ignore-scripts

# ── Stage 2: production ────────────────────────────────────
FROM node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

# Strip npm from the runtime image: the app runs via `node` (see CMD) and
# node:24-alpine's bundled npm ships its own HIGH-CVE deps (picomatch/undici)
# that we don't need at runtime.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/out ./out
COPY --from=build /app/package.json ./
COPY public/ ./public/

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "const port=process.env.HTTP_PORT||'8080';fetch('http://127.0.0.1:'+port+'/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

# Preload the OpenTelemetry bootstrap so auto-instrumentation patches modules
# before app code is imported.
CMD ["node", "--require", "./out/src/telemetry.js", "out/src/index.js"]
