FROM oven/bun:1.4.4 AS build

WORKDIR /workspace

COPY package.json bun.lock ./
COPY apps ./apps
COPY functions ./functions
COPY packages ./packages
RUN bun install --frozen-lockfile --production --filter @deployments-ai/model-gateway-service
# Self-contained bundles; the runtime image needs neither node_modules nor sources.
RUN bun build apps/model-gateway/src/index.ts \
  --target=bun --format=esm --outfile=/app/model-gateway.js \
  && bun build apps/model-gateway/src/render-bifrost-config.ts \
  --target=bun --format=esm --outfile=/app/render-bifrost-config.js

FROM oven/bun:1.4.4-slim

WORKDIR /app
COPY --from=build /app/model-gateway.js /app/render-bifrost-config.js ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
USER bun

# Two commands share this image:
# - gateway (default): `bun /app/model-gateway.js` serves :8080 in front of Bifrost.
# - `bifrost-config` init container: `bun /app/render-bifrost-config.js`, run as user 0, renders
#   config.json and the internal virtual key into $MODEL_GATEWAY_BIFROST_RUNTIME_DIR.
# Exec form: bun is PID 1 and receives the ECS SIGTERM that starts the drain.
CMD ["bun", "/app/model-gateway.js"]
