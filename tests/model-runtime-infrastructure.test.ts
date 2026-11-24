import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const modelRuntime = readFileSync("infrastructure/modules/model-runtime/main.tf", "utf8");
const modelRuntimeService = readFileSync("infrastructure/modules/model-runtime/service.tf", "utf8");
const modelRuntimeVariables = readFileSync(
  "infrastructure/modules/model-runtime/variables.tf",
  "utf8",
);
const modelRuntimeOutputs = readFileSync("infrastructure/modules/model-runtime/outputs.tf", "utf8");
const platformOutputs = readFileSync("infrastructure/modules/platform/outputs.tf", "utf8");
const platformAgentRuntime = readFileSync(
  "infrastructure/modules/platform/agent-runtime.tf",
  "utf8",
);
const modelRuntimeModule = `${modelRuntime}\n${modelRuntimeService}`;

function block(source: string, header: string) {
  const start = source.indexOf(`${header} {`);
  if (start === -1) throw new Error(`Missing ${header}`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end + 2);
}

/** The body of a top-level `name = { ... }` local, through its matching two-space closer. */
function container(name: string) {
  const start = modelRuntimeService.indexOf(`  ${name} = {`);
  if (start === -1) throw new Error(`Missing ${name}`);
  const end = modelRuntimeService.indexOf("\n  }\n", start);
  return modelRuntimeService.slice(start, end + 4);
}

test("keeps shared ALB rules independently owned by their contributing modules", () => {
  const albSecurityGroup = modelRuntime.match(
    /resource "aws_security_group" "alb" \{[\s\S]*?\n\}/u,
  )?.[0];

  expect(albSecurityGroup).toBeDefined();
  expect(albSecurityGroup).not.toContain("\n  ingress {");
  expect(albSecurityGroup).not.toContain('\n  dynamic "ingress"');
  expect(albSecurityGroup).not.toContain("\n  egress {");
  expect(modelRuntime).toContain(
    'resource "aws_vpc_security_group_ingress_rule" "alb_http_from_vpc"',
  );
  expect(modelRuntime).toContain(
    'resource "aws_vpc_security_group_ingress_rule" "alb_https_from_clients"',
  );
  expect(modelRuntime).toContain('resource "aws_vpc_security_group_egress_rule" "alb_all_ipv4"');
});

test("runs Bifrost without Postgres, admin credentials, encryption keys, or scoped keys", () => {
  for (const removed of [
    "postgres",
    "DATABASE_ADMIN_URL",
    "bifrost-role-schema",
    "bifrost-admin",
    "bifrost-api-key",
    "bifrost-encryption-key",
    "BIFROST_ENCRYPTION_KEY",
    "bifrost-scoped-virtual-keys-json",
    "SCOPED_VIRTUAL_KEY",
    "BIFROST_CONFIG",
    "bifrost_runtime",
  ]) {
    expect(modelRuntimeModule).not.toContain(removed);
    expect(modelRuntimeVariables).not.toContain(removed);
    expect(modelRuntimeOutputs).not.toContain(removed);
  }
  expect(modelRuntime).toContain(
    'setunion(["model-grants-json"], local.provider_key_parameter_names)',
  );
  expect(modelRuntime).toContain('name        = "/models/${each.key}"');
  expect(modelRuntime).toContain(
    'contains(var.hosted_providers, "openai") ? ["openai-api-key"] : []',
  );
  expect(modelRuntime).toContain(
    'contains(var.hosted_providers, "openrouter") ? ["openrouter-api-key"] : []',
  );
});

test("renders the Bifrost config into a task-local volume before Bifrost starts", () => {
  const init = container("bifrost_config_container");
  expect(init).toContain('name      = "bifrost-config"');
  expect(init).toContain("image     = var.model_gateway_image");
  expect(init).toContain("essential = false");
  expect(init).toContain('user      = "0"');
  expect(init).toContain('command   = ["bun", "/app/render-bifrost-config.js"]');
  expect(init).toContain(
    '{ name = "MODEL_GATEWAY_BIFROST_RUNTIME_DIR", value = local.runtime_dir }',
  );
  expect(init).toContain('{ name = "MODEL_GATEWAY_HOSTED_PROVIDERS"');
  expect(init).toContain("local.bedrock_hosted ? [");
  expect(init).toContain("readOnly      = false");
  expect(modelRuntimeService).toContain('runtime_dir  = "/run/model-gateway"');
  expect(modelRuntimeService).toMatch(/volume \{\n\s+name = local\.runtime_volume_name\n\s+\}/u);
  expect(modelRuntimeService).not.toContain("efs_volume_configuration");
});

test("binds Bifrost to the task loopback on 8081 with no load balancer mapping", () => {
  const bifrost = container("bifrost_container");
  expect(modelRuntimeService).toContain("bifrost_port = 8081");
  expect(bifrost).toContain('{ name = "APP_HOST", value = "127.0.0.1" }');
  expect(bifrost).toContain('{ name = "APP_PORT", value = tostring(local.bifrost_port) }');
  expect(bifrost).toContain("portMappings = []");
  expect(bifrost).toContain("readOnly      = true");
  expect(bifrost).toContain('containerName = "bifrost-config"');
  expect(bifrost).toContain('condition     = "SUCCESS"');
  expect(bifrost).toContain("cp ${local.runtime_dir}/config.json /app/data/config.json");
  expect(bifrost).toContain("wget -q -O /dev/null http://127.0.0.1:${local.bifrost_port}/health");
  expect(bifrost).toContain('name      = "OPENAI_API_KEY"');
  expect(bifrost).toContain('name      = "OPENROUTER_API_KEY"');
  expect(bifrost.match(/name\s+= "[A-Z_]+_API_KEY"/gu)).toHaveLength(2);
});

test("puts only the gateway behind the internal load balancer", () => {
  const gateway = container("gateway_container");
  const service = block(modelRuntimeService, 'resource "aws_ecs_service" "gateway"');
  const listener = block(modelRuntime, 'resource "aws_lb_listener" "http"');
  const targetGroup = block(modelRuntime, 'resource "aws_lb_target_group" "gateway"');

  expect(modelRuntimeService).toContain("gateway_port = 8080");
  expect(gateway).toContain('name      = "model-gateway"');
  expect(gateway).toContain("containerPort = local.gateway_port");
  expect(gateway).toContain('containerName = "bifrost"');
  expect(gateway).toContain('condition     = "HEALTHY"');
  expect(gateway).toContain(
    '{ name = "MODEL_GATEWAY_BIFROST_URL", value = "http://127.0.0.1:${local.bifrost_port}" }',
  );
  expect(gateway).toContain('value = "${local.runtime_dir}/bifrost-virtual-key"');
  expect(gateway).toContain(
    '{ name = "MODEL_GATEWAY_TRUSTED_SIGNING_KEY_ARNS", value = join(",", local.trusted_signing_key_arns) }',
  );
  expect(gateway).toContain(
    '{ name = "DEPLOYMENTS_AI_EXECUTION_TABLE", value = var.execution_table_name }',
  );
  expect(gateway).toContain("/livez");
  expect(gateway).toContain('"bun",');

  expect(service).toContain('container_name   = "model-gateway"');
  expect(service).toContain("container_port   = local.gateway_port");
  expect(service).toContain("target_group_arn = aws_lb_target_group.gateway.arn");
  expect(service).toContain("deployment_minimum_healthy_percent = 100");
  expect(service).not.toContain("high_availability");
  expect(listener).toContain('type             = "forward"');
  expect(listener).toContain("target_group_arn = aws_lb_target_group.gateway.arn");
  expect(modelRuntime).not.toContain("aws_lb_listener_rule");
  expect(targetGroup).toContain("port                 = local.gateway_port");
  expect(targetGroup).toContain('path                = "/health"');
  expect(modelRuntime).toContain('model_gateway_base_url = "http://${aws_lb.internal.dns_name}"');
  expect(block(modelRuntimeOutputs, 'output "model_gateway_base_url"')).toContain(
    "local.model_gateway_base_url",
  );
  expect(modelRuntimeService).toContain('cpu_architecture        = "ARM64"');
  for (const alarm of ["gateway_target_errors", "gateway_healthy_targets"]) {
    expect(
      block(modelRuntimeService, `resource "aws_cloudwatch_metric_alarm" "${alarm}"`),
    ).toContain("TargetGroup  = aws_lb_target_group.gateway.arn_suffix");
  }
});

test("signs tokens with a dedicated P-256 key the gateway may only verify", () => {
  const key = block(modelRuntime, 'resource "aws_kms_key" "token_signing"');
  const gatewayPolicy = block(modelRuntime, 'data "aws_iam_policy_document" "gateway"');
  expect(key).toContain('customer_master_key_spec = "ECC_NIST_P256"');
  expect(key).toContain('key_usage                = "SIGN_VERIFY"');
  expect(block(modelRuntime, 'resource "aws_kms_alias" "token_signing"')).toContain(
    'name          = "alias/${local.name_prefix}-model-gateway-token"',
  );
  expect(modelRuntime).toContain(
    "trusted_signing_key_arns = concat([aws_kms_key.token_signing.arn], var.model_gateway_previous_signing_key_arns)",
  );
  expect(gatewayPolicy).toContain('actions   = ["kms:GetPublicKey"]');
  expect(gatewayPolicy).toContain("resources = local.trusted_signing_key_arns");
  expect(gatewayPolicy).toContain('actions   = ["dynamodb:GetItem"]');
  expect(gatewayPolicy).toContain("resources = [var.execution_table_arn]");
  expect(gatewayPolicy.match(/kms:Decrypt/gu)).toHaveLength(1);
  expect(gatewayPolicy).toContain(
    'actions   = ["kms:Decrypt"]\n      resources = [statement.value.kms_key_arn]',
  );
  expect(modelRuntimeModule).not.toContain('"kms:Sign"');
  expect(block(modelRuntimeVariables, 'variable "model_gateway_image"')).toContain(
    'can(regex("@sha256:[0-9a-f]{64}$", var.model_gateway_image))',
  );
  expect(platformAgentRuntime).toContain(
    "model_gateway_previous_signing_key_arns = var.model_gateway_previous_signing_key_arns",
  );
  expect(platformAgentRuntime).not.toContain("postgres_admin_url_secret_arn");
});

test("accepts bedrock as a hosted provider and names the supported set on rejection", () => {
  const variable = block(modelRuntimeVariables, 'variable "hosted_providers"');
  expect(variable).toContain('contains(["bedrock", "openai", "openrouter"], provider)');
  expect(variable).toContain(
    "hosted_providers must contain at least one supported provider: bedrock, openai, openrouter.",
  );
  expect(variable).toContain('default     = ["openai", "openrouter"]');
});

test("authorizes Bedrock through the shared task role only when bedrock is hosted", () => {
  const policyDocument = block(modelRuntime, 'data "aws_iam_policy_document" "bedrock"');
  const rolePolicy = block(modelRuntime, 'resource "aws_iam_role_policy" "bedrock"');

  expect(modelRuntime).toContain('bedrock_hosted = contains(var.hosted_providers, "bedrock")');
  expect(policyDocument).toContain("count = local.bedrock_hosted ? 1 : 0");
  expect(rolePolicy).toContain("count = local.bedrock_hosted ? 1 : 0");
  expect(rolePolicy).toContain("role        = aws_iam_role.task.id");
  for (const sid of [
    "InvokeInRegion",
    "CrossRegionInferenceDestinations",
    "MantleInference",
    "ListFoundationModels",
  ]) {
    expect(policyDocument).toMatch(new RegExp(`sid\\s+= "${sid}"`, "u"));
  }
  expect(policyDocument).toContain('variable = "bedrock:InferenceProfileArn"');
  expect(policyDocument).toContain(":bedrock:::foundation-model/*");
  expect(policyDocument).toContain('actions   = ["bedrock-mantle:CreateInference"]');
  expect(policyDocument).toContain('variable = "aws:RequestedRegion"');
  expect(policyDocument).not.toContain("aws-marketplace:");
  expect(policyDocument).not.toContain("sts:AssumeRole");
  expect(modelRuntime).not.toContain("bedrock-api-key");
  expect(modelRuntime).not.toContain("BEDROCK_API_KEY");
});

test("publishes the Bedrock region, hosted providers, and gateway origin", () => {
  expect(block(modelRuntimeOutputs, 'output "bedrock_region"')).toContain(
    "local.bedrock_hosted ? data.aws_region.current.region : null",
  );
  expect(block(modelRuntimeOutputs, 'output "hosted_providers"')).toContain(
    "depends_on = [data.aws_region.current]",
  );
  expect(block(platformOutputs, 'output "model_runtime_bedrock_region"')).toContain(
    "try(module.model_runtime[0].bedrock_region, null)",
  );
  expect(block(platformOutputs, 'output "model_runtime_hosted_providers"')).toContain(
    "try(module.model_runtime[0].hosted_providers, null)",
  );
  expect(block(platformOutputs, 'output "model_gateway_base_url"')).toContain(
    "try(module.model_runtime[0].model_gateway_base_url, null)",
  );
  expect(platformOutputs).not.toContain("bifrost");
});
