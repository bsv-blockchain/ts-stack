# ── Stage 1: build ──────────────────────────────────────────
FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build
RUN npm ci --omit=dev

# ── Stage 2: production ────────────────────────────────────
FROM node:24-alpine

RUN apk upgrade --no-cache

# Strip npm from the runtime image: the app runs via `node` (see CMD) and
# node:24-alpine's bundled npm ships its own HIGH-CVE deps (picomatch/undici)
# that we don't need at runtime.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

ARG APP_COMMIT
ARG APP_VERSION
ENV APP_COMMIT=${APP_COMMIT} APP_VERSION=${APP_VERSION}

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/out ./out
COPY --from=build /app/package.json ./
COPY public/ ./public/

USER node

EXPOSE 8080

# Preload the OpenTelemetry bootstrap so auto-instrumentation patches modules
# before app code is imported.
CMD ["node", "--require", "./out/src/telemetry.js", "--max-http-header-size=512000", "out/src/index.js"]
