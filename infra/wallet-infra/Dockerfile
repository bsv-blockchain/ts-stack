FROM node:22-alpine

# Install nginx
RUN echo "http://dl-4.alpinelinux.org/alpine/v3.3/main" >> /etc/apk/repositories && \
    apk add --no-cache --update nginx && \
    chown -R nginx:www-data /var/lib/nginx

COPY ./nginx.conf /etc/nginx/nginx.conf

EXPOSE 8080
WORKDIR /app
COPY package.json .
COPY src/ src/
RUN npm i
COPY tsconfig.json .
RUN npm i knex typescript -g && \
    npm run build

# Strip npm from the runtime image: the app runs via `node` (see CMD) and
# node:22-alpine's bundled npm ships its own HIGH-CVE deps (picomatch/undici)
# that we don't need at runtime.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Run as non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# Preload the OpenTelemetry bootstrap (ESM --import) before app code so
# auto-instrumentation patches modules before they are imported.
CMD [ "node", "--import", "./out/src/telemetry.js", "out/src/index.js"]
