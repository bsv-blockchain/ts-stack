# Base version 24.22.1-alpine3.24; the digest is the authoritative build input.
FROM node@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build

WORKDIR /app

# No dependency needs a lifecycle script or a native build.
COPY package*.json ./
COPY tsconfig.json ./
RUN npm ci --ignore-scripts

COPY src ./src
RUN npm run build \
 && npm prune --omit=dev

FROM node@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

WORKDIR /app

# The service starts directly with Node, so the runtime image does not retain
# npm or its unrelated dependency graph. Install the reviewed Alpine
# libcrypto3/libssl3 3.5.9-r0 pin for CVE-2026-84782.
RUN apk add --no-cache libcrypto3=3.5.9-r0 libssl3=3.5.9-r0 \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Application files are owned by root and read-only to the runtime user: the
# relay is stateless and writes nothing to disk.
COPY --from=build --chown=root:root --chmod=0444 /app/package.json /app/package-lock.json ./
COPY --from=build --chown=root:root --chmod=0555 /app/node_modules ./node_modules
COPY --from=build --chown=root:root --chmod=0555 /app/dist ./dist

# Keep first-party and incorporated-material terms with the deployed image.
COPY LICENSE.txt THIRD_PARTY_NOTICES.md /usr/share/licenses/ts-stack/
COPY LICENSES /usr/share/licenses/ts-stack/LICENSES
RUN chmod -R a=rX /usr/share/licenses/ts-stack
LABEL org.bsvblockchain.license.notice="/usr/share/licenses/ts-stack/THIRD_PARTY_NOTICES.md"

# HTTP probes and the relay WebSocket share one port. PUBLIC_URLS (the wss://
# urls clients dial) has no default: the relay refuses to start without it.
EXPOSE 8787

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "const port=process.env.PORT||'8787';fetch('http://127.0.0.1:'+port+'/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "--import", "./dist/telemetry.js", "dist/index.js"]
