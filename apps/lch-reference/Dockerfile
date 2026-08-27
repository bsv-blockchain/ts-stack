FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /workspace
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter @bsv/lch build && pnpm --filter lch-reference-app build

FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=4173
WORKDIR /app
COPY --from=build /workspace/apps/lch-reference/dist ./dist
COPY --from=build /workspace/apps/lch-reference/dist-server ./dist-server
EXPOSE 4173
USER node
CMD ["node", "dist-server/nodeServer.js"]
