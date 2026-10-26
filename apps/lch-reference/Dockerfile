FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
RUN corepack enable
WORKDIR /workspace
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter @bsv/lch build && pnpm --filter lch-reference-app build

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
ENV NODE_ENV=production PORT=4173
WORKDIR /app
COPY --from=build /workspace/apps/lch-reference/dist ./dist
COPY --from=build /workspace/apps/lch-reference/dist-server ./dist-server
EXPOSE 4173
USER node
CMD ["node", "dist-server/nodeServer.js"]
