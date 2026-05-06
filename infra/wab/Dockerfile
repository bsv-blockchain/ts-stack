# ------------------------------------------------------------------------------
# 1) Builder Stage: builds TypeScript and compiles native modules
# ------------------------------------------------------------------------------
FROM public.ecr.aws/docker/library/node:22-alpine AS builder

# Install build tools for native modules (sqlite3, etc.)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy only the manifest files first for better caching
COPY package*.json ./
COPY tsconfig.json ./
RUN npm ci

# Copy the source needed for the build
COPY src ./src

# Build the TypeScript project
RUN npm run build

# ------------------------------------------------------------------------------
# 2) Production Stage: minimal runtime image
# ------------------------------------------------------------------------------
FROM public.ecr.aws/docker/library/node:22-alpine

# Patch any OS-level CVEs in the base image
RUN apk upgrade --no-cache

# OCI-compliant labels
LABEL org.opencontainers.image.title="Wallet Authentication Backend"
LABEL org.opencontainers.image.description="Multi-factor authentication backend for BSV wallets"
LABEL org.opencontainers.image.vendor="BSV Blockchain"
LABEL org.opencontainers.image.version="1.4.1"
LABEL org.opencontainers.image.source="https://github.com/bsv-blockchain/wab"
LABEL org.opencontainers.image.licenses="Open-BSV-License-v4"
LABEL org.opencontainers.image.url="https://github.com/bsv-blockchain/wab"
LABEL org.opencontainers.image.documentation="https://github.com/bsv-blockchain/wab/blob/master/README.md"

WORKDIR /app

# Copy package files for reference
COPY --chown=node:node --chmod=0444 package*.json ./

# Copy the compiled TypeScript output
COPY --from=builder --chown=node:node --chmod=0555 /app/dist ./dist

# Copy node_modules from builder (includes compiled native bindings)
COPY --from=builder --chown=node:node --chmod=0555 /app/node_modules ./node_modules

# Expose port
EXPOSE 8080

USER node

# Start command
CMD ["node", "dist/server.js"]
