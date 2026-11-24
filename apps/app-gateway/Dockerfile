FROM oven/bun:1.4.4 AS build

WORKDIR /workspace

COPY package.json bun.lock ./
COPY apps ./apps
COPY functions ./functions
COPY packages ./packages
RUN bun install --frozen-lockfile --production --filter @deployments-ai/app-gateway
# The bundler bakes a module's build-time __dirname into the bundle, and libpg_query's Emscripten
# loader reads libpg-query.wasm from that directory, so the package ships unbundled beside the bundle.
RUN bun build apps/app-gateway/src/index.ts --target=bun --format=esm --external libpg-query \
  --outfile=/app/app-gateway.js \
  && cp -RL "$(dirname "$(dirname "$(dirname "$(bun -e 'process.stdout.write(Bun.resolveSync("libpg-query/wasm/libpg-query.wasm", "/workspace/packages/app-database"))')")")")" /app/node_modules

FROM oven/bun:1.4.4-slim

WORKDIR /app
COPY --from=build /app ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
USER bun

CMD ["bun", "/app/app-gateway.js"]
