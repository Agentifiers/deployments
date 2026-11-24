import { describe, expect, test } from "bun:test";
import { relative } from "node:path";
import { platformImages } from "../scripts/platform-deploy/profiles.ts";

const root = new URL("..", import.meta.url);

async function read(path: string) {
  return Bun.file(new URL(path, root)).text();
}

describe("self-hosted Firecrawl infrastructure", () => {
  test("runs the release's pinned fork image and pins every other image by digest", async () => {
    const compose = await read("infrastructure/firecrawl/compose.yml");
    const expectedImages = [
      "ghcr.io/firecrawl/playwright-service@sha256:",
      "lightpanda/browser@sha256:",
      "amazon/dynamodb-local:3.3.1@sha256:",
      "searxng/searxng@sha256:",
      "coredns/coredns:1.12.3@sha256:",
      "nginx:alpine@sha256:",
    ];

    for (const image of expectedImages) expect(compose).toContain(`image: ${image}`);
    expect(compose).not.toContain("ghcr.io/firecrawl/firecrawl@");
    expect(compose).toContain(
      `image: deployments-ai-firecrawl:local\n    build:\n      context: ${relative("infrastructure/firecrawl", platformImages.firecrawl.context)}\n`,
    );
    expect(compose.match(/\n {4}build:/gu)).toHaveLength(1);
    expect(compose).toContain(
      "image: deployments-ai-firecrawl:local\n    pull_policy: never\n    command: node dist/src/services/dynamo/create-table.js",
    );
    expect(compose).toContain("image: deployments-ai-web-tools-proxy:test");
  });

  test("pins a versioned fork release by digest", async () => {
    const [pin] = (await read(platformImages.firecrawl.dockerfile)).split("\n");
    expect(pin).toMatch(
      /^FROM ghcr\.io\/agentifiers\/firecrawl:(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)@sha256:[0-9a-f]{64} AS firecrawl$/u,
    );
  });

  test("exports the pinned image's DynamoDB table definition and deploys that image", async () => {
    const { file, stage } = platformImages.firecrawl.deploymentMetadata;
    const dockerfile = await read(platformImages.firecrawl.dockerfile);
    const stages = dockerfile.slice(dockerfile.indexOf("\n") + 1);
    expect(dockerfile.match(/^FROM /gmu)).toHaveLength(3);
    expect(stages).toContain(
      `FROM scratch AS ${stage}\nCOPY --from=firecrawl /app/${file} /${file}\n\nFROM firecrawl\n`,
    );
    expect(stages.endsWith("\nFROM firecrawl\n")).toBe(true);

    const table = await read("infrastructure/modules/web-tools-runtime/main.tf");
    const resource = table.slice(table.indexOf('resource "aws_dynamodb_table" "firecrawl"'));
    expect(resource).toContain("for_each = var.firecrawl_table.attributes");
    expect(resource).toContain("for_each = var.firecrawl_table.global_secondary_indexes");
    expect(resource).toContain("attribute_name = var.firecrawl_table.ttl_attribute");
    expect(table).not.toMatch(/"gsi\d/u);
  });

  test("keeps Firecrawl backends internal and routes outbound HTTP through the policy proxy", async () => {
    const compose = await read("infrastructure/firecrawl/compose.yml");
    const api = compose.slice(compose.indexOf("  api:\n"), compose.indexOf("  api-gateway:\n"));
    const playwright = compose.slice(
      compose.indexOf("  playwright-service:\n"),
      compose.indexOf("  searxng:\n"),
    );
    const searxng = compose.slice(compose.indexOf("  searxng:\n"), compose.indexOf("  api:\n"));
    const egressProxy = compose.slice(
      compose.indexOf("  egress-proxy:\n"),
      compose.indexOf("  dynamodb-local:\n"),
    );
    const lightpanda = compose.slice(
      compose.indexOf("  lightpanda:\n"),
      compose.indexOf("  playwright-service:\n"),
    );

    expect(compose).toContain("  backend:\n    internal: true");
    expect(compose).toContain("PROXY_SERVER: http://egress-proxy:3335");
    expect(compose).toContain("OPENAI_BASE_URL: http://egress-proxy:3336");
    expect(compose).toContain("PLAYWRIGHT_MICROSERVICE_URL: http://playwright-service:3000/scrape");
    expect(compose).toContain("LIGHTPANDA_CDP_URL: ws://172.30.250.92:9222");
    expect(egressProxy).toContain("MODEL_GATEWAY_BASE_URL: ${FIRECRAWL_OPENAI_BASE_URL:-}");
    expect(egressProxy).toContain(
      "MODEL_GATEWAY_TOKEN_ISSUER: ${FIRECRAWL_MODEL_GATEWAY_TOKEN_ISSUER:-}",
    );
    expect(egressProxy).toContain("tokenIssuer:\n        process.env.MODEL_GATEWAY_TOKEN_ISSUER");
    expect(egressProxy).toContain("createModelGatewayProxy");
    expect(egressProxy).toContain("- backend\n      - egress");
    expect(api).toContain("<<: *firecrawl-environment");
    expect(api).toContain("networks:\n      - backend");
    expect(api).not.toContain("- egress");
    expect(api).not.toContain("ports:");
    expect(api).toContain("lightpanda:\n        condition: service_started");
    expect(lightpanda).toContain("- --http-proxy\n      - http://egress-proxy:3335");
    expect(lightpanda).toContain('LIGHTPANDA_DISABLE_TELEMETRY: "true"');
    expect(lightpanda).toContain("dns:\n      - 172.30.250.53");
    expect(lightpanda).toContain(
      "networks:\n      backend:\n        ipv4_address: 172.30.250.92\n",
    );
    expect(lightpanda).not.toContain("- egress");
    expect(lightpanda).not.toContain("ports:");
    expect(playwright).toContain("PROXY_SERVER: http://egress-proxy:3335");
    expect(playwright).toContain("dns:\n      - 172.30.250.53");
    expect(playwright).not.toContain("- egress");
    expect(searxng).toContain("dns:\n      - 172.30.250.53");
    expect(searxng).not.toContain("- egress");
  });

  test("renders through a digest-pinned Lightpanda sidecar and a model-free Chromium service", async () => {
    const moduleDir = "infrastructure/modules/web-tools-runtime";
    const [runtime, chromium, network, variables] = await Promise.all([
      read(`${moduleDir}/runtime.tf`),
      read(`${moduleDir}/chromium.tf`),
      read(`${moduleDir}/network.tf`),
      read(`${moduleDir}/variables.tf`),
    ]);
    const lightpanda = runtime.slice(
      runtime.indexOf("lightpanda_container = {"),
      runtime.indexOf("firecrawl_container = {"),
    );
    const firecrawl = runtime.slice(runtime.indexOf("firecrawl_container = {"));

    expect(variables).toMatch(
      /variable "lightpanda_image" \{[^}]*default\s+= "lightpanda\/browser@sha256:[0-9a-f]{64}"/u,
    );
    expect(variables).toContain('regex("@sha256:[0-9a-f]{64}$", var.lightpanda_image)');
    expect(lightpanda).toMatch(/image\s+= var\.lightpanda_image/u);
    expect(lightpanda).toContain('"--host", "127.0.0.1"');
    expect(lightpanda).toContain('"--http-proxy", "http://127.0.0.1:3335"');
    expect(lightpanda).toContain('{ name = "LIGHTPANDA_DISABLE_TELEMETRY", value = "true" }');
    expect(lightpanda).toMatch(/portMappings\s+= \[\]/u);
    expect(firecrawl).toContain('{ name = "LIGHTPANDA_CDP_URL", value = "ws://127.0.0.1:9222" }');
    expect(firecrawl).toContain(
      '{ name = "PLAYWRIGHT_MICROSERVICE_URL", value = "http://${local.chromium_dns_name}:3000/scrape" }',
    );
    expect(runtime).not.toContain("var.playwright_image");

    expect(chromium).toContain("createBrowserEgressProxy().listen(3335, '127.0.0.1');");
    for (const modelEgress of [
      "createModelGatewayProxy",
      "MODEL_GATEWAY",
      "OPENAI_",
      "task_role_arn",
    ]) {
      expect(chromium).not.toContain(modelEgress);
    }
    expect(chromium).toContain('{ name = "PROXY_SERVER", value = "http://127.0.0.1:3335" }');
    expect(chromium).toContain('{ name = "ALLOW_LOCAL_WEBHOOKS", value = "false" }');
    expect(chromium).toContain("assign_public_ip = false");

    const chromiumIngress = network.match(
      /resource "aws_vpc_security_group_ingress_rule" "[^"]+" \{[^}]*aws_security_group\.chromium\.id[^}]*\}/gu,
    );
    expect(chromiumIngress).toHaveLength(1);
    expect(chromiumIngress?.[0]).toMatch(
      /referenced_security_group_id\s+= aws_security_group\.service\.id\s+from_port\s+= 3000\s+to_port\s+= 3000/u,
    );
  });

  test("stores Firecrawl state in DynamoDB Local instead of Postgres, Redis or RabbitMQ", async () => {
    const compose = await read("infrastructure/firecrawl/compose.yml");
    const api = compose.slice(compose.indexOf("  api:\n"), compose.indexOf("  api-gateway:\n"));
    const dynamodb = compose.slice(
      compose.indexOf("  dynamodb-local:\n"),
      compose.indexOf("  dynamodb-init:\n"),
    );

    expect(compose).toContain("FIRECRAWL_DYNAMODB_ENDPOINT: http://dynamodb-local:8000");
    expect(compose).toContain("FIRECRAWL_DYNAMODB_TABLE: firecrawl");
    expect(dynamodb).toContain("command: -jar DynamoDBLocal.jar -inMemory -sharedDb");
    expect(dynamodb).toContain("networks:\n      - backend\n");
    expect(dynamodb).not.toContain("ports:");
    expect(api).toContain("dynamodb-init:\n        condition: service_completed_successfully");
    for (const removed of ["POSTGRES_", "REDIS_", "RABBITMQ", "BULL_AUTH_KEY", "\nvolumes:"]) {
      expect(compose).not.toContain(removed);
    }
  });

  test("publishes only a loopback API gateway and does not enable hosted-only services", async () => {
    const [compose, nginx] = await Promise.all([
      read("infrastructure/firecrawl/compose.yml"),
      read("infrastructure/firecrawl/nginx.conf"),
    ]);
    const gatewayStart = compose.indexOf("  api-gateway:\n");
    const gateway = compose.slice(gatewayStart, compose.indexOf("\nnetworks:\n", gatewayStart));

    expect(gateway).toContain("127.0.0.1:${FIRECRAWL_PORT:-3002}:3002");
    expect(nginx).toContain("client_max_body_size 64m");
    expect(gateway).toContain("- backend");
    expect(gateway).toContain("- ingress");
    expect(compose).toContain('USE_DB_AUTHENTICATION: "false"');
    expect(compose).not.toContain("BROWSER_SERVICE_URL:");
    expect(compose).not.toContain("EXTRACT_V3_BETA_URL:");
    expect(compose).not.toContain("RESEARCH_PROXY_URL:");
    expect(compose).not.toContain("SUPPORT_AGENT_URL:");
    expect(compose).not.toContain("AUTUMN_SECRET_KEY:");
  });
});
