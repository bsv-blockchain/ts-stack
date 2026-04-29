# ── Stage 1: build ──────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build
RUN npm ci --omit=dev

# ── Stage 2: production ────────────────────────────────────
FROM node:22-alpine

RUN apk upgrade --no-cache

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

CMD ["node", "--max-http-header-size=512000", "out/src/index.js"]
