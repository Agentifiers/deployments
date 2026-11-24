import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_AGENT_MODEL_FALLBACK_IDS } from "@deployments-ai/model-gateway";

const read = (path: string) => readFileSync(path, "utf8");
/** Collapses OpenTofu's column alignment so assertions survive `tofu fmt`. */
const squash = (source: string) => source.replace(/ {2,}=/gu, " =");

function terraformFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return entry === ".terraform" ? [] : terraformFiles(path);
    return path.endsWith(".tf") ? [path] : [];
  });
}

const allTerraform = terraformFiles("infrastructure").map((path) => ({ path, source: read(path) }));
const issuers = read("infrastructure/modules/agent-runtime/model-token-issuers.tf");
const agentRuntimeMain = read("infrastructure/modules/agent-runtime/main.tf");
const workerService = read("infrastructure/modules/agent-runtime/worker-service.tf");
const evaluations = read("infrastructure/modules/agent-runtime/evaluations.tf");
const memoryRuntime = read("infrastructure/modules/memory-runtime/main.tf");
const memoryOutputs = read("infrastructure/modules/memory-runtime/outputs.tf");
const brainRuntime = read("infrastructure/modules/brain-runtime/main.tf");
const brainOutputs = read("infrastructure/modules/brain-runtime/outputs.tf");
const platformApiPolicy = read("infrastructure/modules/platform-api/api-iam.tf");
const platformApiFunction = read("infrastructure/modules/platform-api/governance-runtime.tf");
const webToolsMain = read("infrastructure/modules/web-tools-runtime/main.tf");
const webToolsRuntime = read("infrastructure/modules/web-tools-runtime/runtime.tf");
const stackAgentRuntime = read("infrastructure/modules/platform/agent-runtime.tf");
const stackMemoryAndBrain = read("infrastructure/modules/platform/memory-and-brain.tf");
const stackApi = read("infrastructure/modules/platform/identity-and-api.tf");
const stackWebTools = read("infrastructure/modules/platform/web-tools.tf");
const stackRuntimeVariables = read("infrastructure/modules/platform/variables-runtimes.tf");

function section(source: string, start: string, end: string) {
  const from = source.indexOf(start);
  if (from === -1) throw new Error(`Missing ${start}`);
  const to = source.indexOf(end, from + start.length);
  return source.slice(from, to === -1 ? undefined : to);
}

function statement(source: string, sid: string) {
  const at = source.search(new RegExp(`sid\\s+= "${sid}"`, "u"));
  if (at === -1) throw new Error(`Missing statement ${sid}`);
  const start = source.lastIndexOf("statement {", at);
  return source.slice(start, source.indexOf("\n  }\n", at));
}

describe("model token issuers", () => {
  test("deploys one issuer per caller class from the agent-runtime artifact", () => {
    const issuerTable = section(issuers, "model_token_issuers = {", "\n  }\n}");
    for (const [name, kind, tenantModels] of [
      ["run", "run", "false"],
      ["agent-worker", "service", "false"],
      ["evaluations", "service", "true"],
      ["memory", "service", "true"],
      ["brain", "service", "false"],
      ["web-tools", "service", "false"],
    ] as const) {
      const entry = section(issuerTable, `    ${name} = {`, "\n    }");
      expect(entry).toContain(`kind           = "${kind}"`);
      expect(entry).toContain(`tenant_models  = ${tenantModels}`);
    }
    const lambda = section(issuers, 'resource "aws_lambda_function" "model_token_issuer"', "\n}\n");
    expect(lambda).toContain('function_name = "${local.name_prefix}-model-token-${each.key}"');
    expect(lambda).toContain('handler       = "model-token-issuer-main.handler"');
    expect(lambda).toContain('runtime       = "nodejs26.x"');
    expect(lambda).toContain('architectures = ["arm64"]');
    expect(lambda).toContain("role          = aws_iam_role.model_token_issuer[each.key].arn");
    for (const name of [
      "DEPLOYMENTS_AI_MODEL_TOKEN_ISSUER_KIND",
      "DEPLOYMENTS_AI_MODEL_TOKEN_SIGNING_KEY_ARN",
      "DEPLOYMENTS_AI_MODEL_GRANTS_PARAMETER_ARN",
      "DEPLOYMENTS_AI_MODEL_TOKEN_SERVICE ",
      "DEPLOYMENTS_AI_MODEL_TOKEN_SERVICE_MODELS",
      "DEPLOYMENTS_AI_MODEL_TOKEN_TENANT_MODELS",
      "DEPLOYMENTS_AI_CONTROL_TABLE",
      "DEPLOYMENTS_AI_EXECUTION_TABLE",
    ]) {
      expect(lambda).toContain(name);
    }
  });

  test("traces configured service models to the platform model variables", () => {
    const models = section(stackAgentRuntime, "model_token_service_models = {", "\n  }");
    expect(models).toContain(
      "agent_worker = [var.brain_runtime_answer_model, var.memory_runtime_embedding_model, var.memory_runtime_rerank_model]",
    );
    expect(models).toContain(
      "brain        = [var.brain_runtime_answer_model, var.memory_runtime_embedding_model]",
    );
    expect(models).toContain(
      "memory       = [var.memory_runtime_embedding_model, var.memory_runtime_rerank_model]",
    );
    expect(models).toContain(
      "web_tools    = [var.web_tools_firecrawl_model_name, var.web_tools_firecrawl_embedding_model_name]",
    );
    expect(stackWebTools).toContain(
      "firecrawl_model_name            = var.web_tools_firecrawl_model_name",
    );
    expect(stackWebTools).toContain(
      "firecrawl_embedding_model_name  = var.web_tools_firecrawl_embedding_model_name",
    );
  });

  test("sends service chat clients the default fallbacks their issuers admit", () => {
    const variable = section(
      stackRuntimeVariables,
      'variable "model_gateway_service_fallback_model_ids" {',
      "\n}\n",
    );
    const defaultIds = JSON.parse(variable.match(/default\s+= (\[.*\])/u)?.[1] ?? "null");
    expect(defaultIds).toEqual([...DEFAULT_AGENT_MODEL_FALLBACK_IDS]);
    expect(squash(stackAgentRuntime)).toContain(
      "model_token_service_fallback_models = var.model_gateway_service_fallback_model_ids",
    );

    const issuerTable = section(issuers, "model_token_issuers = {", "\n  }\n}");
    for (const name of ["agent-worker", "evaluations", "memory", "brain"]) {
      expect(section(issuerTable, `    ${name} = {`, "\n    }")).toContain(
        "var.model_token_service_fallback_models",
      );
    }
    for (const name of ["run", "web-tools"]) {
      expect(section(issuerTable, `    ${name} = {`, "\n    }")).not.toContain("fallback_models");
    }

    const clientFallbacks =
      'DEPLOYMENTS_AI_DEFAULT_MODEL_FALLBACK_IDS = join(",", var.model_token_service_fallback_models)';
    expect(squash(workerService)).toContain(clientFallbacks);
    expect(squash(evaluations)).toContain(clientFallbacks);
    const moduleFallbacks =
      'DEPLOYMENTS_AI_DEFAULT_MODEL_FALLBACK_IDS = join(",", var.model_gateway_fallback_ids)';
    expect(squash(memoryRuntime)).toContain(moduleFallbacks);
    expect(squash(brainRuntime)).toContain(moduleFallbacks);
    expect(
      squash(stackMemoryAndBrain).match(
        /model_gateway_fallback_ids = var\.model_gateway_service_fallback_model_ids/gu,
      ),
    ).toHaveLength(2);
    expect(squash(stackApi)).toContain(
      'DEPLOYMENTS_AI_DEFAULT_MODEL_FALLBACK_IDS = join(",", var.model_gateway_service_fallback_model_ids)',
    );
  });

  test("grants kms:Sign on the token key to the issuer roles and nobody else", () => {
    // Other modules sign with their own keys (governance exports, identity tokens); none of them
    // may reference the model gateway token key.
    const tokenKeySigners = allTerraform.filter(
      ({ source }) =>
        source.includes('"kms:Sign"') &&
        /token_signing|model_gateway_token_signing_key_arn/u.test(source),
    );
    expect(tokenKeySigners.map(({ path }) => path)).toEqual([
      "infrastructure/modules/agent-runtime/model-token-issuers.tf",
    ]);
    const tokenKeyReaders = allTerraform
      .filter(({ source }) => source.includes("model_gateway_token_signing_key_arn"))
      .map(({ path }) => path);
    expect(tokenKeyReaders.toSorted()).toEqual([
      "infrastructure/modules/agent-runtime/model-token-issuers.tf",
      "infrastructure/modules/agent-runtime/variables.tf",
      "infrastructure/modules/platform/agent-runtime.tf",
    ]);
    const signStatement = statement(issuers, "SignModelGatewayTokens");
    expect(signStatement).toContain('actions   = ["kms:Sign"]');
    expect(signStatement).toContain("resources = [var.model_gateway_token_signing_key_arn]");
    expect(
      section(issuers, 'resource "aws_iam_role_policy" "model_token_issuer"', "\n}\n"),
    ).toContain("role   = aws_iam_role.model_token_issuer[each.key].id");
    expect(statement(issuers, "ReadModelGrants")).toContain(
      "resources = [var.model_grants_parameter_arn]",
    );
    expect(issuers).not.toContain("kms:Decrypt");
    const records = statement(issuers, "ReadAdmissionRecords");
    expect(records).toContain('for table in ["control", "execution"]');
    expect(records).not.toContain("PutItem");
  });

  test("lets exactly the listed invokers call each issuer", () => {
    const invokers = allTerraform.flatMap(({ path, source }) =>
      [
        ...source.matchAll(/aws_lambda_function\.model_token_issuer\["([a-z-]+)"\]\.arn/gu),
        ...source.matchAll(/model_token_issuers\["([a-z-]+)"\]/gu),
      ].map((match) => `${path}:${match[1]}`),
    );
    expect(invokers.toSorted()).toEqual(
      [
        "infrastructure/modules/agent-runtime/main.tf:agent-worker",
        "infrastructure/modules/agent-runtime/evaluations.tf:evaluations",
        "infrastructure/modules/agent-runtime/worker-service.tf:agent-worker",
        "infrastructure/modules/agent-runtime/worker-service.tf:run",
        "infrastructure/modules/platform/identity-and-api.tf:brain",
        "infrastructure/modules/platform/memory-and-brain.tf:brain",
        "infrastructure/modules/platform/memory-and-brain.tf:memory",
        "infrastructure/modules/platform/web-tools.tf:web-tools",
      ].toSorted(),
    );

    const workerTask = section(
      workerService,
      'data "aws_iam_policy_document" "agent_worker_task"',
      '\nresource "aws_iam_role_policy" "agent_worker_task"',
    );
    expect(workerTask).not.toContain('"kms:Sign"');
    expect(statement(workerTask, "InvokeModelTokenIssuers")).toContain(
      'aws_lambda_function.model_token_issuer["run"].arn',
    );
    expect(statement(evaluations, "InvokeEvaluationModelTokenIssuer")).toContain(
      'aws_lambda_function.model_token_issuer["evaluations"].arn',
    );
    expect(evaluations).toContain("role   = aws_iam_role.worker.id");
    const workerLambdaRole = section(
      agentRuntimeMain,
      'data "aws_iam_policy_document" "worker"',
      '\ndata "aws_partition" "current"',
    );
    expect(statement(workerLambdaRole, "InvokeAgentWorkerModelTokenIssuer")).toContain(
      'resources = [aws_lambda_function.model_token_issuer["agent-worker"].arn]',
    );
    expect(workerLambdaRole).not.toContain('model_token_issuer["run"]');
    expect(workerLambdaRole).not.toContain('"kms:Sign"');

    const memoryInvoke = section(memoryRuntime, 'sid       = "InvokeModelTokenIssuer"', "}");
    expect(memoryInvoke).toContain("resources = [var.model_gateway_token_issuer.arn]");
    expect(
      section(
        memoryRuntime,
        'dynamic "statement" {\n    for_each = contains(["memory-api", "memory-flush"',
        "content",
      ),
    ).toContain(
      '"memory-api", "memory-flush", "memory-index", "memory-operation", "memory-shadow"',
    );
    const brainInvoke = brainRuntime.slice(
      brainRuntime.lastIndexOf("dynamic", brainRuntime.indexOf('"InvokeModelTokenIssuer"')),
      brainRuntime.indexOf('"InvokeModelTokenIssuer"'),
    );
    expect(brainInvoke).toContain('for_each = each.key == "brain-index-worker" ? [1] : []');
    expect(platformApiPolicy).toContain('sid       = "InvokeBrainModelTokenIssuer"');
    expect(statement(webToolsMain, "InvokeModelTokenIssuer")).toContain(
      "resources = [var.model_gateway_token_issuer.arn]",
    );
    expect(webToolsRuntime).toContain("task_role_arn            = aws_iam_role.task.arn");
  });
});

describe("model gateway callers", () => {
  test("removes every static gateway credential from the infrastructure", () => {
    for (const { path, source } of allTerraform) {
      for (const removed of [
        "DEPLOYMENTS_AI_BIFROST_BASE_URL",
        "DEPLOYMENTS_AI_BIFROST_SECRET_ARN",
        "DEPLOYMENTS_AI_BRAIN_BIFROST_",
        "DEPLOYMENTS_AI_MODEL_GATEWAY_API_KEY_SECRET_ARN",
        "DEPLOYMENTS_AI_MODEL_GATEWAY_VIRTUAL_KEYS_SECRET_ARN",
        "model_gateway_api_key_secret_arn",
        "model_gateway_virtual_keys_secret_arn",
        "bifrost_secret_arn",
        "bifrost-api-key",
      ]) {
        expect({ path, found: source.includes(removed) }).toEqual({ path, found: false });
      }
    }
  });

  test("gives the agent worker run and service issuers plus the grants parameter", () => {
    const environment = squash(
      section(agentRuntimeMain, "agent_worker_environment = merge({", "}, "),
    );
    expect(environment).toContain(
      "DEPLOYMENTS_AI_MODEL_GATEWAY_BASE_URL = var.model_gateway_base_url",
    );
    expect(environment).toContain(
      'DEPLOYMENTS_AI_MODEL_GATEWAY_RUN_TOKEN_ISSUER = aws_lambda_function.model_token_issuer["run"].function_name',
    );
    expect(environment).toContain(
      'DEPLOYMENTS_AI_MODEL_GATEWAY_TOKEN_ISSUER = aws_lambda_function.model_token_issuer["agent-worker"].function_name',
    );
    expect(environment).toContain(
      "DEPLOYMENTS_AI_MODEL_GRANTS_PARAMETER_ARN = var.model_grants_parameter_arn",
    );
    expect(workerService).toContain("var.model_grants_parameter_arn,");
  });

  test("gives the evaluation worker and runtime API their gateway environment", () => {
    expect(squash(evaluations)).toContain(
      'DEPLOYMENTS_AI_MODEL_GATEWAY_TOKEN_ISSUER = aws_lambda_function.model_token_issuer["evaluations"].function_name',
    );
    expect(squash(evaluations)).toContain(
      "DEPLOYMENTS_AI_MODEL_GRANTS_PARAMETER_ARN = var.model_grants_parameter_arn",
    );
    const runtimeApi = squash(
      section(agentRuntimeMain, "public_runtime_environment = merge(", "})"),
    );
    expect(runtimeApi).toContain(
      "DEPLOYMENTS_AI_MODEL_GRANTS_PARAMETER_ARN = var.model_grants_parameter_arn",
    );
    expect(runtimeApi).not.toContain("DEPLOYMENTS_AI_MODEL_GATEWAY_TOKEN_ISSUER");
  });

  test("gives memory, Brain, the platform API, and Web Tools their own issuers", () => {
    for (const source of [memoryRuntime, brainRuntime, platformApiFunction]) {
      expect(squash(source)).toContain(
        "DEPLOYMENTS_AI_MODEL_GATEWAY_TOKEN_ISSUER = var.model_gateway_token_issuer.function_name",
      );
      expect(squash(source)).toContain(
        "DEPLOYMENTS_AI_MODEL_GATEWAY_BASE_URL = var.model_gateway_base_url",
      );
    }
    expect(memoryOutputs).not.toContain("MODEL_GATEWAY");
    expect(brainOutputs).not.toContain("MODEL_GATEWAY");
    expect(squash(platformApiFunction)).toContain(
      "DEPLOYMENTS_AI_MODEL_GRANTS_PARAMETER_ARN = var.model_grants_parameter_arn",
    );
    expect(squash(stackMemoryAndBrain)).toContain(
      'model_gateway_token_issuer = module.agent_runtime[0].model_token_issuers["memory"]',
    );
    expect(squash(stackMemoryAndBrain)).toContain(
      'model_gateway_token_issuer = module.agent_runtime[0].model_token_issuers["brain"]',
    );
    expect(stackApi).toContain('module.agent_runtime[0].model_token_issuers["brain"]');
    expect(squash(stackWebTools)).toContain(
      'model_gateway_base_url = "${module.model_runtime[0].model_gateway_base_url}/v1"',
    );
  });

  test("runs Firecrawl with a placeholder key behind the token-minting proxy", () => {
    expect(webToolsMain).toContain("tokenIssuer: process.env.MODEL_GATEWAY_TOKEN_ISSUER");
    expect(webToolsRuntime).toContain(
      '{ name = "MODEL_GATEWAY_TOKEN_ISSUER", value = var.model_gateway_token_issuer.function_name }',
    );
    expect(webToolsRuntime).toContain(
      '{ name = "OPENAI_API_KEY", value = "unused-model-gateway-proxy" }',
    );
    const firecrawl = section(webToolsRuntime, "firecrawl_container = {", "\n  }\n");
    expect(squash(firecrawl)).toContain("secrets = []");
  });
});
