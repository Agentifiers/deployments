FROM oven/bun:1.4.4 AS build

WORKDIR /workspace

COPY package.json bun.lock ./
COPY apps ./apps
COPY functions ./functions
COPY packages ./packages
RUN bun install --frozen-lockfile --production --filter @deployments-ai/worker
# One self-contained bundle; the runtime image needs neither node_modules nor sources.
RUN bun build functions/worker/src/agent-worker-service-main.ts \
  --target=bun --format=esm --loader .woff:dataurl --outfile=/app/agent-worker.js

FROM oven/bun:1.4.4-slim

WORKDIR /app
COPY --from=build /app/agent-worker.js ./agent-worker.js

ENV NODE_ENV=production
USER bun

# Exec form: bun is PID 1 and receives the ECS SIGTERM that starts the drain.
CMD ["bun", "/app/agent-worker.js"]
