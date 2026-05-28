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

# better-sqlite3 native build (see builder stage). Install build tools, run
# npm ci, then remove the toolchain in the same layer to keep the image slim.
RUN apk add --no-cache --virtual .build-deps python3 make g++

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev \
 && apk del .build-deps

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

# Run the application
CMD ["node", "dist/server.js"]
