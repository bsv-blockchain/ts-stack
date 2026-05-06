# ---- Build stage ----
FROM node:20-alpine AS builder

WORKDIR /app

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

# Ensure all OS packages are up to date (patch CVEs in base image)
RUN apk upgrade --no-cache

# Install nginx
RUN apk add --no-cache nginx && \
    chown -R nginx:www-data /var/lib/nginx

WORKDIR /app

# Copy package files and install production deps only
COPY --chown=node:node --chmod=0444 package*.json ./
RUN npm ci --omit=dev

# Copy built output from builder
COPY --from=builder --chown=node:node --chmod=0555 /app/out ./out
COPY --from=builder --chown=node:node --chmod=0444 /app/knexfile.js ./knexfile.js

# Copy nginx config
COPY ./nginx.conf /etc/nginx/nginx.conf

# Expose the API port
EXPOSE 8080

USER node

# Start the app
CMD [ "node", "out/src/index.js" ]
