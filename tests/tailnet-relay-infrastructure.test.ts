import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const relay = readFileSync("infrastructure/modules/tailnet-relay/main.tf", "utf8");
const platformRelay = readFileSync(
  "infrastructure/modules/platform/openai-tailnet-relay.tf",
  "utf8",
);
const network = readFileSync("infrastructure/modules/network/main.tf", "utf8");
const customerMain = readFileSync("infrastructure/environments/customer/main.tf", "utf8");

function block(source: string, header: string) {
  const start = source.indexOf(`${header} {`);
  if (start === -1) throw new Error(`Missing ${header}`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end + 2);
}

test("admits only the model gateway on the forwarded port", () => {
  const securityGroup = block(relay, 'resource "aws_security_group" "relay"');
  const ingress = securityGroup.slice(
    securityGroup.indexOf("ingress {"),
    securityGroup.indexOf("egress {"),
  );
  expect(ingress).toContain("from_port       = var.upstream.port");
  expect(ingress).toContain("to_port         = var.upstream.port");
  expect(ingress).toContain("security_groups = [var.client_security_group_id]");
  expect(ingress).not.toContain("cidr_blocks");
  expect(platformRelay).toContain(
    "client_security_group_id = module.model_runtime[0].gateway_security_group_id",
  );
});

test("names relay IAM resources inside the customer deploy role's workload prefixes", () => {
  const bootstrap = readFileSync("infrastructure/bootstrap/customer/main.tf", "utf8");
  const prefixes = [
    ...(/workload_name_prefixes\s*=\s*\[([^\]]*)\]/u.exec(bootstrap)?.[1] ?? "").matchAll(
      /"([^"]+)"/gu,
    ),
  ].map((match) => match[1] ?? "");
  const name = /^\s*name\s*=\s*"([^"]+)"/mu.exec(platformRelay)?.[1] ?? "";
  expect(prefixes.some((prefix) => name.startsWith(prefix))).toBe(true);
  expect(block(relay, 'resource "aws_iam_role" "relay"')).toMatch(
    /name_prefix\s+= "\$\{var\.name\}-"/u,
  );
});

test("lets the relay read only its own auth-key parameter", () => {
  expect(relay).not.toContain("aws_iam_role_policy_attachment");
  const policy = block(relay, 'data "aws_iam_policy_document" "relay"');
  const parameterStatements = policy
    .split("statement {")
    .filter((statement) => /ssm:Get/u.test(statement));
  expect(parameterStatements).toHaveLength(1);
  expect(parameterStatements[0]).toContain('actions   = ["ssm:GetParameter"]');
  expect(parameterStatements[0]).toContain("resources = [aws_ssm_parameter.auth_key.arn]");
});

test("never lets OpenTofu overwrite the operator-written auth key", () => {
  const parameter = block(relay, 'resource "aws_ssm_parameter" "auth_key"');
  expect(parameter).toContain('type        = "SecureString"');
  expect(parameter).toContain("ignore_changes = [value]");
});

test("runs the relay without a public address and with IMDSv2", () => {
  const instance = block(relay, 'resource "aws_instance" "relay"');
  expect(instance).toContain("associate_public_ip_address = false");
  expect(instance).toContain('http_tokens                 = "required"');
});

test("keeps CGNAT forwarding rejected at the NAT instance", () => {
  const denyList = network.slice(
    network.indexOf("private_or_reserved_ipv4_cidrs = ["),
    network.indexOf("]", network.indexOf("private_or_reserved_ipv4_cidrs = [")),
  );
  expect(denyList).toContain('"100.64.0.0/10"');
});

test("never relays customer-install model traffic to a tailnet", () => {
  expect(customerMain).not.toContain("model_runtime_openai_tailnet_upstream");
});

test("catalogs the relayed model ids instead of listing api.openai.com", () => {
  const stackAgentRuntime = readFileSync(
    "infrastructure/modules/platform/agent-runtime.tf",
    "utf8",
  );
  const catalogSync = readFileSync(
    "infrastructure/modules/agent-runtime/model-catalog-sync.tf",
    "utf8",
  );
  expect(stackAgentRuntime).toMatch(
    /model_catalog_openai_model_ids\s+= local\.openai_tailnet_relay_enabled \? var\.model_runtime_openai_tailnet_upstream\.model_ids : \[\]/u,
  );
  expect(catalogSync).toContain(
    'DEPLOYMENTS_AI_OPENAI_MODEL_IDS = join(",", var.model_catalog_openai_model_ids)',
  );
});
