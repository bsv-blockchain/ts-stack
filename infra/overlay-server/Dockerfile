# Base version 24.22.3-alpine3.24; the digest is the authoritative build input.
FROM node@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS build

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./
RUN npm ci --ignore-scripts

COPY src ./src
RUN npm run build \
 && npm prune --omit=dev

FROM node@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5

WORKDIR /app

COPY --from=build --chown=root:root --chmod=0444 /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

# Keep first-party and incorporated-material terms with the deployed image.
COPY LICENSE NOTICE PATENTS THIRD_PARTY_NOTICES.md /usr/share/licenses/ts-stack/
COPY LICENSES /usr/share/licenses/ts-stack/LICENSES
RUN chmod -R a=rX /usr/share/licenses/ts-stack
LABEL org.bsvblockchain.license.notice="/usr/share/licenses/ts-stack/THIRD_PARTY_NOTICES.md"

# The service starts directly with Node, so the runtime image does not retain
# npm or its unrelated dependency graph. Install the reviewed Alpine
# libcrypto3/libssl3 3.5.9-r0 pin for CVE-2026-84782.
RUN apk add --no-cache libcrypto3=3.5.9-r0 libssl3=3.5.9-r0 \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "--import", "./dist/telemetry.js", "dist/index.js"]
