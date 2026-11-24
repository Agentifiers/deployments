import {
  GetSecretValueCommand,
  SecretsManagerClient,
  type GetSecretValueCommandOutput,
} from "@aws-sdk/client-secrets-manager";
import {
  GetParameterCommand,
  SSMClient,
  type GetParameterCommandOutput,
} from "@aws-sdk/client-ssm";

export type AwsSecretReference =
  | { readonly kind: "parameter"; readonly reference: string; readonly region: string }
  | { readonly kind: "secret"; readonly reference: string; readonly region: string };

export interface AwsSecretReferenceClients {
  readonly parameterStore?: {
    send(command: GetParameterCommand): Promise<GetParameterCommandOutput>;
  };
  readonly secretsManager?: {
    send(command: GetSecretValueCommand): Promise<GetSecretValueCommandOutput>;
  };
}

export function parseAwsSecretReference(reference: string): AwsSecretReference {
  const normalized = reference.trim();
  const [prefix, partition, service, region, accountId, ...resourceParts] = normalized.split(":");
  const resource = resourceParts.join(":");
  if (
    prefix !== "arn" ||
    !partition ||
    !region ||
    !/^\d{12}$/u.test(accountId ?? "") ||
    !resource
  ) {
    throw new Error("AWS secret reference must be a complete account-scoped ARN.");
  }
  if (service === "ssm" && resource.startsWith("parameter/")) {
    return { kind: "parameter", reference: normalized, region };
  }
  if (service === "secretsmanager" && resource.startsWith("secret:")) {
    return { kind: "secret", reference: normalized, region };
  }
  throw new Error("AWS secret reference must identify SSM Parameter Store or Secrets Manager.");
}

export async function loadAwsSecretString(
  reference: string,
  options: AwsSecretReferenceClients & {
    readonly versionId?: string;
    readonly versionStage?: string;
  } = {},
) {
  const parsed = parseAwsSecretReference(reference);
  if (parsed.kind === "parameter") {
    if (options.versionId || options.versionStage) {
      throw new Error("SSM parameter references do not support Secrets Manager version selectors.");
    }
    const ownedClient = options.parameterStore
      ? undefined
      : new SSMClient({ region: parsed.region });
    const client = options.parameterStore ?? ownedClient!;
    try {
      const result = await client.send(
        new GetParameterCommand({ Name: parsed.reference, WithDecryption: true }),
      );
      const value = result.Parameter?.Value;
      if (typeof value !== "string" || !value.trim()) {
        throw new Error(`SSM parameter ${parsed.reference} has no string value.`);
      }
      return value;
    } finally {
      ownedClient?.destroy();
    }
  }

  const ownedClient = options.secretsManager
    ? undefined
    : new SecretsManagerClient({ region: parsed.region });
  const client = options.secretsManager ?? ownedClient!;
  try {
    const result = await client.send(
      new GetSecretValueCommand({
        SecretId: parsed.reference,
        ...(options.versionId ? { VersionId: options.versionId } : {}),
        ...(options.versionStage ? { VersionStage: options.versionStage } : {}),
      }),
    );
    if (result.SecretBinary !== undefined) {
      throw new Error(`Secrets Manager secret ${parsed.reference} must be stored as a string.`);
    }
    const value = result.SecretString;
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`Secrets Manager secret ${parsed.reference} has no string value.`);
    }
    return value;
  } finally {
    ownedClient?.destroy();
  }
}
