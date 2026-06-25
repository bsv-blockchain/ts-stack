# Use an official Node.js runtime as the base image
FROM node:22-alpine

# Set working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json .
COPY tsconfig.json .

# Install dependencies
RUN npm install

# Copy application source code into the container
COPY src ./src

# Expose the application port
EXPOSE 8080

RUN npm run build

# Strip npm from the runtime image: node:22-alpine's bundled npm ships its own
# HIGH-CVE deps (picomatch/undici). The app is started directly with `node`
# (CMD below preloads telemetry then runs dist/index.js), so npm is not needed.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

RUN chown -R node:node /app

USER node

# Start the application with the OpenTelemetry bootstrap preloaded so
# auto-instrumentation patches modules before app code is imported.
CMD ["node", "--import", "./dist/telemetry.js", "dist/index.js"]
