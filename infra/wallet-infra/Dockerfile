FROM node:24-alpine AS build

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev

FROM node:24-alpine

RUN apk upgrade --no-cache \
 && apk add --no-cache nginx \
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
