import { describe, expect, test } from "bun:test";

const moduleRoot = new URL("../infrastructure/modules/web-tools-runtime/", import.meta.url);
const networkModuleRoot = new URL("../infrastructure/modules/network/", import.meta.url);
const bootstrapRoot = new URL("../infrastructure/bootstrap/customer/", import.meta.url);

describe("hosted Web Tools infrastructure", () => {
  test("stores Firecrawl state in one on-demand DynamoDB table with TTL", async () => {
    const main = await Bun.file(new URL("main.tf", moduleRoot)).text();
    const variables = await Bun.file(new URL("variables.tf", moduleRoot)).text();

    expect(main).toContain('resource "aws_dynamodb_table" "firecrawl"');
    expect(main).toContain("billing_mode = var.firecrawl_table.billing_mode");
    expect(variables).toContain('var.firecrawl_table.billing_mode == "PAY_PER_REQUEST"');
    expect(main).toContain("deletion_protection_enabled = var.deletion_protection_enabled");
    expect(main).toContain("enabled = var.point_in_time_recovery_enabled");
    expect(main).toMatch(
      /ttl \{\s*attribute_name = var\.firecrawl_table\.ttl_attribute\s*enabled\s+= true/u,
    );
  });

  test("grants the Firecrawl task item-level access to its table only", async () => {
    const main = await Bun.file(new URL("main.tf", moduleRoot)).text();
    const runtime = await Bun.file(new URL("runtime.tf", moduleRoot)).text();

    const policy = main.slice(main.indexOf('data "aws_iam_policy_document" "task_dynamodb"'));
    const actions = [...policy.matchAll(/"(dynamodb:[A-Za-z*]+)"/gu)].map((match) => match[1]);
    expect(actions).toEqual([
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:ConditionCheckItem",
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
    ]);
    expect(policy).toContain('"${aws_dynamodb_table.firecrawl.arn}/index/*"');
    expect(runtime).toContain("task_role_arn            = aws_iam_role.task.arn");
    expect(runtime).toContain(
      '{ name = "FIRECRAWL_DYNAMODB_TABLE", value = aws_dynamodb_table.firecrawl.name }',
    );
    expect(runtime).toContain('{ name = "AWS_REGION", value = data.aws_region.current.region }');
  });

  test("runs Firecrawl without PostgreSQL, Redis or RabbitMQ", async () => {
    const files = await Promise.all(
      ["main.tf", "network.tf", "outputs.tf", "runtime.tf", "variables.tf"].map((name) =>
        Bun.file(new URL(name, moduleRoot)).text(),
      ),
    );
    const module = files.join("\n");

    expect(await Bun.file(new URL("nuq.sql", moduleRoot)).exists()).toBe(false);
    for (const removed of [
      "aws_elasticache",
      "redis",
      "rabbitmq",
      "postgres",
      "BULL_AUTH_KEY",
      "/runtime/firecrawl.env",
      "runtime-config",
    ]) {
      expect(module.toLowerCase()).not.toContain(removed.toLowerCase());
    }
    expect(module).toContain(
      'command           = ["node", "dist/src/harness.js", "--start-docker"]',
    );
  });

  test("routes private-subnet DynamoDB traffic through a gateway endpoint", async () => {
    const networkMain = await Bun.file(new URL("main.tf", networkModuleRoot)).text();

    expect(networkMain).toMatch(
      /resource "aws_vpc_endpoint" "dynamodb" \{\s*vpc_id\s+= aws_vpc\.this\.id\s*service_name\s+= "com\.amazonaws\.\$\{data\.aws_region\.current\.region\}\.dynamodb"\s*vpc_endpoint_type = "Gateway"\s*route_table_ids\s+= \[for table in aws_route_table\.private : table\.id\]/u,
    );
  });

  test("allows the deployment role to manage Web Tools IAM resources", async () => {
    const bootstrap = await Bun.file(new URL("main.tf", bootstrapRoot)).text();

    expect(bootstrap).toMatch(/workload_name_prefixes\s*=\s*\[[^\]]*"web-tools-"/u);
  });

  test("restricts web egress to public IPv4 ranges", async () => {
    const network = await Bun.file(new URL("network.tf", moduleRoot)).text();
    const networkMain = await Bun.file(new URL("main.tf", networkModuleRoot)).text();

    expect(network).toContain('resource "aws_vpc_security_group_egress_rule" "public_http"');
    expect(network).toContain('resource "aws_vpc_security_group_egress_rule" "public_https"');
    expect(network.match(/for_each = toset\(local\.task_egress_ipv4_cidrs\)/gu)).toHaveLength(2);
    expect(network).not.toContain('cidr_ipv4         = "0.0.0.0/0"');

    for (const cidr of [
      "0.0.0.0/8",
      "10.0.0.0/8",
      "100.64.0.0/10",
      "127.0.0.0/8",
      "169.254.0.0/16",
      "172.16.0.0/12",
      "192.0.0.0/24",
      "192.0.2.0/24",
      "192.88.99.0/24",
      "192.168.0.0/16",
      "198.18.0.0/15",
      "198.51.100.0/24",
      "203.0.113.0/24",
      "224.0.0.0/4",
      "240.0.0.0/4",
    ]) {
      expect(networkMain).toContain(`"${cidr}"`);
    }
    expect(networkMain).toContain("chain='FCK_NAT_DENY_RESERVED'");
    expect(networkMain).toContain('-s "$${source_cidr}" -d "$${destination_cidr}" -j REJECT');
    expect(networkMain).toContain("user_data_replace_on_change = true");
  });

  test("routes Firecrawl model features through the token-minting gateway proxy", async () => {
    const main = await Bun.file(new URL("main.tf", moduleRoot)).text();
    const network = await Bun.file(new URL("network.tf", moduleRoot)).text();
    const runtime = await Bun.file(new URL("runtime.tf", moduleRoot)).text();

    expect(main).toContain("createModelGatewayProxy");
    expect(main).toContain("tokenIssuer: process.env.MODEL_GATEWAY_TOKEN_ISSUER");
    expect(main).not.toContain("bearerAsBifrostVirtualKey");
    expect(main).toContain('sid       = "InvokeModelTokenIssuer"');
    expect(network).toContain(
      'resource "aws_vpc_security_group_egress_rule" "service_to_model_gateway"',
    );
    expect(runtime).toContain('{ name = "OPENAI_BASE_URL", value = "http://127.0.0.1:3336" }');
    expect(runtime).toContain('{ name = "OPENAI_API_KEY", value = "unused-model-gateway-proxy" }');
    expect(runtime).not.toContain("model_gateway_api_key_secret_arn");
    expect(runtime).toContain('{ name = "MODEL_NAME", value = var.firecrawl_model_name }');
  });
});
