# Use Node.js 18 LTS as base image
FROM node:22-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

RUN npm install -g tsx@4.21.0 typescript@5.8.3 --ignore-scripts

# Install dependencies
RUN npm ci --ignore-scripts

# Copy source code
COPY src ./src
COPY demo.ts ./

# Build the TypeScript code
RUN npm run build && chown -R node:node /app

# Expose the P2P port (9901 by default)
EXPOSE 9901

# Set environment variables for better container compatibility
ENV NODE_ENV=production

USER node

# Run the demo
CMD ["npm", "run", "demo"]
