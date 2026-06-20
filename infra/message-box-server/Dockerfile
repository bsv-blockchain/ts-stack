# ---- Build stage ----
FROM node:20-alpine AS builder

WORKDIR /app

# Native deps (better-sqlite3) compile from source on Alpine (musl, no prebuilt
# binaries) — needs python3/make/g++.
RUN apk add --no-cache python3 make g++

# Copy package files first for better layer caching
COPY package*.json ./
COPY tsconfig*.json ./
COPY knexfile.ts ./

# Install all dependencies (including dev deps for build)
RUN npm install

# Install global tools (optional, depends on how you're running knex)
RUN npm install -g knex typescript

# Copy source code required for compilation
COPY src ./src

# Build the TypeScript project
RUN npm run build

# Copy compiled knexfile.js to /app root (where imports like '../../knexfile.js' expect it)
RUN cp out/knexfile.js ./knexfile.js

# ---- Production stage ----
FROM node:20-alpine

# Ensure all OS packages are up to date (patch CVEs in base image) and install nginx
RUN apk upgrade --no-cache && \
    apk add --no-cache nginx && \
    chown -R nginx:www-data /var/lib/nginx

WORKDIR /app

# Copy package files and install production deps only.
# better-sqlite3 compiles from source on Alpine; add the toolchain just for the
# install, then remove it in the same layer to keep the image slim.
COPY --chown=root:root --chmod=0444 package*.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
 && npm ci --omit=dev \
 && apk del .build-deps \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Copy built output from builder
COPY --from=builder --chown=root:root --chmod=0555 /app/out ./out
COPY --from=builder --chown=root:root --chmod=0444 /app/knexfile.js ./knexfile.js

# Copy nginx config
COPY ./nginx.conf /etc/nginx/nginx.conf

# Expose the API port
EXPOSE 8080

USER node

# Start the app
CMD [ "node", "out/src/index.js" ]
