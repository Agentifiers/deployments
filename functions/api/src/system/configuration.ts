import type { SYSTEM_MODEL_PROVIDERS } from "@deployments-ai/api-contract/system";
import {
  loadAwsSecretString,
  parseAwsSecretReference,
  type AwsSecretReferenceClients,
} from "@deployments-ai/secret-store";
import { Schema } from "effect";

export const SYSTEM_OPERATOR_CONFIGURATION_PARAMETER_ENV =
  "DEPLOYMENTS_AI_SYSTEM_OPERATOR_PARAMETER_ARN";

const Name = Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(512)));
const SecretArn = Name.pipe(
  Schema.check(
    Schema.makeFilter<string>((value) => {
      try {
        parseAwsSecretReference(value);
        return undefined;
      } catch (cause) {
        return cause instanceof Error ? cause.message : "Expected an AWS secret ARN.";
      }
    }),
  ),
);

const KEYED_MODEL_PROVIDERS = ["openai", "openrouter"] as const satisfies ReadonlyArray<
  (typeof SYSTEM_MODEL_PROVIDERS)[number]
>;
/**
 * OpenTofu-owned identifiers of what the install runs, stored in an SSM parameter. Lambda
 * function names come from the installation record instead: the deploy tool records exactly the
 * functions it released.
 */
const SystemOperatorConfigurationDocument = Schema.Struct({
  alarmNamePrefix: Schema.String.pipe(Schema.check(Schema.isMaxLength(255))),
  bedrockRegion: Schema.NullOr(Name),
  /** `[component, clusterName, serviceName]` for every ECS service the install runs. */
  ecsServices: Schema.Array(Schema.Tuple([Name, Name, Name])).pipe(
    Schema.check(Schema.isMaxLength(64)),
  ),
  /** Model provider key references the install wires, read through metadata-only APIs. */
  modelProviderSecrets: Schema.Struct(
    Object.fromEntries(
      KEYED_MODEL_PROVIDERS.map((provider) => [provider, Schema.optional(SecretArn)]),
    ) as Record<(typeof KEYED_MODEL_PROVIDERS)[number], Schema.optional<typeof SecretArn>>,
  ),
  observability: Schema.NullOr(
    Schema.Struct({
      athenaWorkgroup: Schema.NullOr(Name),
      historyRetentionDays: Schema.NullOr(Schema.Number),
      tableBucket: Schema.NullOr(Name),
      tableNamespace: Schema.NullOr(Name),
    }),
  ),
});

export type SystemOperatorConfiguration = typeof SystemOperatorConfigurationDocument.Type;

export type SystemOperatorParameterStore = NonNullable<AwsSecretReferenceClients["parameterStore"]>;

/** A failed read may be transient; an invalid document stays invalid until the next deploy. */
export type SystemOperatorConfigurationLoad =
  | { readonly kind: "configured"; readonly configuration: SystemOperatorConfiguration }
  | { readonly kind: "invalid"; readonly error: string }
  | { readonly kind: "unconfigured" }
  | { readonly kind: "unreadable"; readonly error: string };

const decodeConfiguration = Schema.decodeUnknownSync(SystemOperatorConfigurationDocument, {
  onExcessProperty: "error",
});

/** Unconfigured when OpenTofu did not configure operator reads (for example local stacks). */
export async function loadSystemOperatorConfiguration(
  environment: NodeJS.ProcessEnv,
  parameterStore?: SystemOperatorParameterStore,
): Promise<SystemOperatorConfigurationLoad> {
  const parameterArn = environment[SYSTEM_OPERATOR_CONFIGURATION_PARAMETER_ENV]?.trim();
  if (!parameterArn) return { kind: "unconfigured" };
  let raw: string;
  try {
    raw = await loadAwsSecretString(parameterArn, parameterStore ? { parameterStore } : {});
  } catch (cause) {
    return {
      error: `System operator configuration ${parameterArn} could not be read: ${cause instanceof Error ? cause.message : "unknown error"}`,
      kind: "unreadable",
    };
  }
  try {
    return { configuration: decodeConfiguration(JSON.parse(raw)), kind: "configured" };
  } catch (cause) {
    return {
      error: `System operator configuration ${parameterArn} is invalid: ${cause instanceof Error ? cause.message : "unparseable"}`,
      kind: "invalid",
    };
  }
}
