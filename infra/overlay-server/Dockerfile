# Base version 24.18.0-alpine3.24; the digest is the authoritative build input.
FROM node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS build

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./
RUN npm ci --ignore-scripts

COPY src ./src
RUN npm run build \
 && npm prune --omit=dev

FROM node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

WORKDIR /app

COPY --from=build --chown=root:root --chmod=0444 /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

# Keep first-party and incorporated-material terms with the deployed image.
COPY LICENSE.txt THIRD_PARTY_NOTICES.md /usr/share/licenses/ts-stack/
COPY LICENSES /usr/share/licenses/ts-stack/LICENSES
RUN chmod -R a=rX /usr/share/licenses/ts-stack
LABEL org.bsvblockchain.license.notice="/usr/share/licenses/ts-stack/THIRD_PARTY_NOTICES.md"

# The service starts directly with Node, so the runtime image does not retain
# npm or its unrelated dependency graph. The pinned base contains OpenSSL
# 3.5.7-r0; retain the reviewed 3.5.8-r0 fix for CVE-2026-14456.
RUN apk add --no-cache libcrypto3=3.5.8-r0 libssl3=3.5.8-r0 \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "--import", "./dist/telemetry.js", "dist/index.js"]
