FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/sdk/package.json ./packages/sdk/package.json
RUN npm ci --ignore-scripts
COPY packages ./packages
COPY apps ./apps
COPY scripts/build.mjs ./scripts/build.mjs
RUN npm run build && npm prune --omit=dev --ignore-scripts
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/db/migrations ./packages/db/migrations
COPY --from=build --chown=node:node /app/apps/indexer/sql ./apps/indexer/sql
USER node
CMD ["node","dist/api.mjs"]
