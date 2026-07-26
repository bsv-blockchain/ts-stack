FROM node:24.18.0-alpine3.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS build

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./
RUN npm ci --ignore-scripts

COPY src ./src
RUN npm run build \
 && npm prune --omit=dev

FROM node:24.18.0-alpine3.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

WORKDIR /app

COPY --from=build --chown=root:root --chmod=0444 /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

# The service starts directly with Node, so the runtime image does not retain
# npm or its unrelated dependency graph.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

USER node

EXPOSE 8080

CMD ["node", "--import", "./dist/telemetry.js", "dist/index.js"]
