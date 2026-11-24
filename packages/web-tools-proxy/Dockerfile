FROM oven/bun:1.4.4 AS dependencies

WORKDIR /workspace

COPY package.json bun.lock ./
COPY apps ./apps
COPY functions ./functions
COPY packages ./packages
RUN bun install --frozen-lockfile --production --filter @deployments-ai/web-tools-proxy

# Only the proxy's dependency closure reaches the runtime image, so its digest changes only
# when that closure does; any other change would replace both Web Tools task definitions.
FROM oven/bun:1.4.4

WORKDIR /app
COPY --from=dependencies /workspace/node_modules ./node_modules
COPY --from=dependencies /workspace/packages/web-tools-proxy/node_modules ./packages/web-tools-proxy/node_modules
COPY --from=dependencies /workspace/packages/model-gateway/node_modules ./packages/model-gateway/node_modules
COPY packages/web-tools-proxy/src ./packages/web-tools-proxy/src
COPY packages/web-tools-proxy/package.json ./packages/web-tools-proxy/package.json
COPY packages/model-gateway/src ./packages/model-gateway/src
COPY packages/model-gateway/package.json ./packages/model-gateway/package.json
COPY packages/net-security/src ./packages/net-security/src
COPY packages/net-security/package.json ./packages/net-security/package.json

USER bun

# The Web Tools task definition and Firecrawl compose supply the proxy command.
