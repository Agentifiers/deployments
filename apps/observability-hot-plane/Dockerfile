FROM oven/bun:1.4.4 AS dependencies

WORKDIR /workspace

COPY package.json bun.lock ./
COPY apps ./apps
COPY functions ./functions
COPY packages ./packages
RUN bun install --frozen-lockfile --production --filter @deployments-ai/observability-hot-plane

FROM oven/bun:1.4.4-slim

WORKDIR /app
COPY --from=dependencies /workspace/node_modules ./node_modules
COPY --from=dependencies /workspace/apps/observability-hot-plane/node_modules ./apps/observability-hot-plane/node_modules
COPY --from=dependencies /workspace/packages/db/node_modules ./packages/db/node_modules
COPY --from=dependencies /workspace/packages/observability/node_modules ./packages/observability/node_modules
COPY apps/observability-hot-plane/src ./apps/observability-hot-plane/src
COPY apps/observability-hot-plane/package.json ./apps/observability-hot-plane/package.json
# The erasure-fence facade decodes canonical governance records (keys, ids, record schemas).
COPY packages/db/src ./packages/db/src
COPY packages/db/package.json ./packages/db/package.json
COPY packages/observability/src ./packages/observability/src
COPY packages/observability/package.json ./packages/observability/package.json

ENV PORT=3000
EXPOSE 3000

CMD ["bun", "run", "apps/observability-hot-plane/src/index.ts"]
