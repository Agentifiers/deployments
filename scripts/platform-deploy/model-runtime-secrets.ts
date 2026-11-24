import { ECSClient, UpdateServiceCommand, waitUntilServicesStable } from "@aws-sdk/client-ecs";
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import {
  awsSecretReferenceRegion,
  createModelRuntimeSecretValues,
  MODEL_GATEWAY_PROVIDERS,
  MODEL_OPERATOR_GRANTS_ENV,
  type ModelGatewayProvider,
  type ModelRuntimeSecretValues,
} from "@deployments-ai/model-gateway";
import { isResourceNotFound } from "../aws-service-errors.ts";
import { log, type Environment } from "./process.ts";
import type { TerraformOutputs } from "./terraform.ts";

type ModelRuntimeParameterName = keyof ModelRuntimeSecretValues;

const PROVIDER_KEY_PARAMETER_NAMES = [
  "openai-api-key",
  "openrouter-api-key",
] as const satisfies readonly ModelRuntimeParameterName[];
const MODEL_RUNTIME_PARAMETER_NAMES = [
  "model-grants-json",
  ...PROVIDER_KEY_PARAMETER_NAMES,
] as const satisfies readonly ModelRuntimeParameterName[];
/** Grants seeded on first deployment when the operator supplies none. */
const EMPTY_MODEL_GRANTS_JSON = "[]";

function parameterName(parameterArn: string) {
  const marker = ":parameter/";
  const markerIndex = parameterArn.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Invalid SSM parameter ARN: ${parameterArn}`);
  return `/${parameterArn.slice(markerIndex + marker.length)}`;
}

async function currentParameterString(client: SSMClient, parameterArn: string) {
  try {
    const current = await client.send(
      new GetParameterCommand({ Name: parameterArn, WithDecryption: true }),
    );
    return current.Parameter?.Value === "pending" ? undefined : current.Parameter?.Value;
  } catch (cause) {
    if (isResourceNotFound(cause)) return undefined;
    throw cause;
  }
}

function configuredEnv(environment: Environment, names: readonly string[]) {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function configuredOrCurrent(
  environment: Environment,
  names: readonly string[],
  currentValues: ReadonlyMap<ModelRuntimeParameterName, string | undefined>,
  parameter: ModelRuntimeParameterName,
) {
  const value = configuredEnv(environment, names) ?? currentValues.get(parameter)?.trim();
  if (value) return value;
  throw new Error(`Missing required environment value: ${names.join(" or ")}.`);
}

function requiredOutput<T>(outputs: TerraformOutputs, name: string): T {
  const value = outputs[name];
  if (value === undefined || value === null) {
    throw new Error(`OpenTofu output ${name} is empty.`);
  }
  return value as T;
}

/** Hosted providers from the applied root (`model_runtime_hosted_providers`). */
export function modelRuntimeHostedProviders(outputs: TerraformOutputs): ModelGatewayProvider[] {
  const value = outputs.model_runtime_hosted_providers;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (provider): provider is ModelGatewayProvider =>
        typeof provider === "string" &&
        MODEL_GATEWAY_PROVIDERS.includes(provider as ModelGatewayProvider),
    )
  ) {
    throw new Error(
      `OpenTofu output model_runtime_hosted_providers must list supported providers: ${MODEL_GATEWAY_PROVIDERS.join(", ")}.`,
    );
  }
  return value;
}

/**
 * Operator grants from `DEPLOYMENTS_AI_MODEL_GRANTS_JSON`; when unset, the stored grants are kept,
 * and a first deployment seeds no grants.
 */
export function operatorModelGrantsJson(environment: Environment, current: string | undefined) {
  return (
    configuredEnv(environment, [MODEL_OPERATOR_GRANTS_ENV]) ?? current ?? EMPTY_MODEL_GRANTS_JSON
  );
}

/** Provider API keys are read by Bifrost at task start; grants are read per use by callers. */
export function modelRuntimeRestartRequired(changedParameters: readonly string[]) {
  return changedParameters.some((name) =>
    (PROVIDER_KEY_PARAMETER_NAMES as readonly string[]).includes(name),
  );
}

async function forceRollingDeployment(outputs: TerraformOutputs, region: string) {
  const cluster = requiredOutput<string>(outputs, "model_runtime_cluster_arn");
  const service = requiredOutput<string>(outputs, "model_runtime_service_name");
  const client = new ECSClient({ region });
  await client.send(new UpdateServiceCommand({ cluster, forceNewDeployment: true, service }));
  const result = await waitUntilServicesStable(
    { client, maxDelay: 15, maxWaitTime: 900, minDelay: 5 },
    { cluster, services: [service] },
  );
  if (result.state !== "SUCCESS") {
    throw new Error(
      `Model gateway ECS service did not stabilize: ${result.reason ?? result.state}`,
    );
  }
  log("Rolled the model gateway ECS service onto the updated provider keys.");
}

/**
 * Writes the provider API keys and operator model grants. `prepareEmpty` only seeds absent or
 * pending parameters before the first full apply; the full sync writes changed parameters and,
 * when a provider key changed, rolls the model gateway service so Bifrost reads the new key.
 */
export async function syncModelRuntimeSecrets(input: {
  readonly environment: Environment;
  readonly outputs: TerraformOutputs;
  readonly prepareEmpty: boolean;
}) {
  const { environment, prepareEmpty } = input;
  const parameterArns = requiredOutput<Record<string, string>>(
    input.outputs,
    "model_runtime_secret_arns",
  );
  const hostedProviders = modelRuntimeHostedProviders(input.outputs);
  const region = awsSecretReferenceRegion(parameterArns);
  const parametersClient = new SSMClient({ region });
  const currentValues = new Map<ModelRuntimeParameterName, string | undefined>(
    await Promise.all(
      MODEL_RUNTIME_PARAMETER_NAMES.filter((name) => parameterArns[name]).map(
        async (name) =>
          [name, await currentParameterString(parametersClient, parameterArns[name]!)] as const,
      ),
    ),
  );
  const values = createModelRuntimeSecretValues({
    hostedProviders,
    ...(hostedProviders.includes("openai")
      ? {
          openAiApiKey: configuredOrCurrent(
            environment,
            ["DEPLOYMENTS_AI_OPENAI_API_KEY", "OPENAI_API_KEY"],
            currentValues,
            "openai-api-key",
          ),
        }
      : {}),
    ...(hostedProviders.includes("openrouter")
      ? {
          openRouterApiKey: configuredOrCurrent(
            environment,
            ["DEPLOYMENTS_AI_OPENROUTER_API_KEY", "OPENROUTER_API_KEY"],
            currentValues,
            "openrouter-api-key",
          ),
        }
      : {}),
    operatorModelGrantsJson: operatorModelGrantsJson(
      environment,
      currentValues.get("model-grants-json"),
    ),
  });
  const parameterEntries = Object.entries(values).map(([name, value]) => {
    const parameterArn = parameterArns[name];
    if (!parameterArn) throw new Error(`OpenTofu did not output the ${name} parameter ARN.`);
    return { name, parameterArn, value };
  });
  const pendingEntries = parameterEntries.filter(({ name, value }) =>
    prepareEmpty
      ? currentValues.get(name as ModelRuntimeParameterName) === undefined
      : currentValues.get(name as ModelRuntimeParameterName) !== value,
  );
  if (pendingEntries.length === 0) {
    log("Model runtime parameters are already current.");
    return;
  }
  for (const { name, parameterArn, value } of pendingEntries) {
    await parametersClient.send(
      new PutParameterCommand({
        Name: parameterName(parameterArn),
        Overwrite: true,
        Tier: "Intelligent-Tiering",
        Type: "SecureString",
        Value: value,
      }),
    );
    log(`${prepareEmpty ? "Seeded" : "Updated"} model runtime parameter ${name}.`);
  }
  if (!prepareEmpty && modelRuntimeRestartRequired(pendingEntries.map(({ name }) => name))) {
    await forceRollingDeployment(input.outputs, region);
  }
}
