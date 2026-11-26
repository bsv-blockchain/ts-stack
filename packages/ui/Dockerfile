# Governed Node.js base: 24.22.3-alpine3.24
FROM node@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS build
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN npm install --global --ignore-scripts "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")"
COPY . .
RUN --mount=type=cache,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir=/pnpm/store \
    && pnpm rebuild esbuild --store-dir=/pnpm/store

ARG UI_WORKSPACE
ARG UI_PATH
RUN test -n "$UI_WORKSPACE" && test -n "$UI_PATH" \
    && pnpm -r --filter "${UI_WORKSPACE}..." --fail-if-no-match --if-present run build \
    && test -s "$UI_PATH/build/index.html" \
    && cp -R "$UI_PATH/build" /out \
    && chmod -R a+rX /out

# Governed Node.js base: 24.22.3-alpine3.24
FROM node@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS runtime
RUN apk add --no-cache libcrypto3=3.5.9-r0 libssl3=3.5.9-r0 nginx=1.30.8-r0 \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY LICENSE NOTICE PATENTS THIRD_PARTY_NOTICES.md /usr/share/licenses/ts-stack/
COPY LICENSES /usr/share/licenses/ts-stack/LICENSES
COPY packages/ui/nginx.conf /etc/nginx/ui.conf
COPY --from=build /out /srv/ui

LABEL org.bsvblockchain.license.notice="/usr/share/licenses/ts-stack/THIRD_PARTY_NOTICES.md"

USER node
EXPOSE 8080
STOPSIGNAL SIGQUIT
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r => { process.exitCode = r.ok ? 0 : 1 }).catch(() => { process.exitCode = 1 })"]
ENTRYPOINT ["nginx", "-e", "stderr", "-c", "/etc/nginx/ui.conf", "-g", "daemon off;"]
