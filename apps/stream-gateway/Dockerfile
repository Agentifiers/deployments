FROM oven/bun:1.4.4 AS dependencies

WORKDIR /workspace

COPY package.json bun.lock ./
COPY apps ./apps
COPY functions ./functions
COPY packages ./packages
RUN bun install --frozen-lockfile --production --filter @deployments-ai/stream-gateway

FROM oven/bun:1.4.4-slim

WORKDIR /app
COPY --from=dependencies /workspace/node_modules ./node_modules
COPY --from=dependencies /workspace/apps/stream-gateway/node_modules ./apps/stream-gateway/node_modules
COPY --from=dependencies /workspace/packages/secret-store/node_modules ./packages/secret-store/node_modules
COPY --from=dependencies /workspace/packages/streaming/node_modules ./packages/streaming/node_modules
COPY apps/stream-gateway/src ./apps/stream-gateway/src
COPY apps/stream-gateway/package.json ./apps/stream-gateway/package.json
COPY packages/secret-store/src ./packages/secret-store/src
COPY packages/secret-store/package.json ./packages/secret-store/package.json
COPY packages/streaming/src ./packages/streaming/src
COPY packages/streaming/package.json ./packages/streaming/package.json

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
USER bun

CMD ["bun", "run", "apps/stream-gateway/src/index.ts"]
