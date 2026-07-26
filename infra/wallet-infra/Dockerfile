# Base version 24.18.0-alpine3.24; the digest is the authoritative build input.
FROM node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS build

RUN apk add --no-cache g++ make python3

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts \
 && npm rebuild better-sqlite3

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev

FROM node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

RUN apk add --no-cache nginx \
 && chown -R nginx:www-data /var/lib/nginx

COPY ./nginx.conf /etc/nginx/nginx.conf

WORKDIR /app

COPY --from=build --chown=root:root --chmod=0444 /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/out ./out

# The service starts directly with Node, so the runtime image does not retain
# npm or its unrelated dependency graph.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

USER node

EXPOSE 8080

CMD ["node", "--import", "./out/src/telemetry.js", "out/src/index.js"]
