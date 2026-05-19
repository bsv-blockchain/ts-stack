# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

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

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

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
