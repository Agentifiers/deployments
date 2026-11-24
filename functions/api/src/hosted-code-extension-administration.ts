import {
  HOSTED_CODE_DEFAULT_ENTRYPOINT,
  HOSTED_CODE_DEFAULT_MEMORY_MIB,
  HOSTED_CODE_DEFAULT_TIMEOUT_MS,
} from "@deployments-ai/api-contract";
import {
  makeHostedCodeArtifactPersistence,
  PersistenceError,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { HOSTED_CODE_SECRETS_VAULT_PURPOSE } from "@deployments-ai/tools";
import {
  asObject,
  id,
  text,
  vaultReference,
  type AdministrationPreparedCredentialMutation,
  type SecretReferenceValue,
} from "./administration-persistence-contracts.ts";
import type { AdministrationPersistenceContext } from "./administration-persistence-context.ts";

export interface PreparedHostedCodeExtension {
  readonly authSecretRef?: SecretReferenceValue;
  readonly execution: Readonly<Record<string, unknown>>;
  readonly operations: readonly TransactionOperation[];
}

/**
 * Validates a hosted code declaration against its immutable artifact and stores declared secrets
 * in the credential vault. The persisted execution holds only secret names, never values.
 */
export function makeHostedCodeExtensionAdministration(context: AdministrationPersistenceContext) {
  const { credentialValue, databaseValue, dependencies, generateId } = context;
  const artifacts = makeHostedCodeArtifactPersistence(dependencies.database);

  return async function prepareHostedCodeExtension(input: {
    readonly adapterId: Ulid;
    readonly body: Readonly<Record<string, unknown>>;
    readonly execution: Readonly<Record<string, unknown>>;
    readonly previous?: {
      readonly authSecretRef?: unknown;
      readonly execution: Readonly<Record<string, unknown>>;
    };
    readonly scope: {
      readonly environmentId: Ulid;
      readonly organizationId: Ulid;
      readonly projectId: Ulid;
    };
  }): Promise<PreparedHostedCodeExtension> {
    if (input.body.providerKey !== undefined || input.body.callbackSecret !== undefined) {
      throw new PersistenceError(
        "unprocessable",
        "hosted_code_credentials_forbidden",
        "Hosted code tools use declared secrets, not a provider key or callback secret.",
      );
    }
    const contentHash = text(input.execution.contentHash, "execution.contentHash");
    const artifact = await databaseValue(
      artifacts.load({
        contentHash,
        environmentId: input.scope.environmentId,
        organizationId: input.scope.organizationId,
      }),
    );
    if (!artifact || artifact.data.projectId !== input.scope.projectId) {
      throw new PersistenceError(
        "unprocessable",
        "hosted_code_artifact_not_found",
        "Upload the hosted code artifact to this environment before declaring the tool.",
      );
    }

    let credential: AdministrationPreparedCredentialMutation | undefined;
    let secretNames = Array.isArray(input.previous?.execution.secretNames)
      ? (input.previous.execution.secretNames as readonly string[])
      : [];
    if (input.body.secrets !== undefined) {
      const values = Object.fromEntries(
        Object.entries(asObject(input.body.secrets)).map(([name, value]) => [
          name,
          typeof value === "string" && value.length > 0 ? value : text(value, `secrets.${name}`),
        ]),
      );
      const previousReference = input.previous?.authSecretRef
        ? vaultReference(input.previous.authSecretRef)
        : undefined;
      credential = await credentialValue(async () =>
        dependencies.credentials.prepareWrite({
          ...(previousReference ? { expectedGeneration: previousReference.generation } : {}),
          identity: {
            credentialId: previousReference?.credentialId ?? id(await generateId()),
            environmentId: input.scope.environmentId,
            organizationId: input.scope.organizationId,
            ownerId: input.adapterId,
            ownerType: "tool-adapter",
            projectId: input.scope.projectId,
            purpose: HOSTED_CODE_SECRETS_VAULT_PURPOSE,
          },
          secret: { values },
        }),
      );
      secretNames = Object.keys(values).toSorted();
    }

    return {
      ...(credential ? { authSecretRef: credential.reference } : {}),
      execution: {
        contentHash: artifact.data.contentHash,
        entrypoint:
          input.execution.entrypoint === undefined
            ? HOSTED_CODE_DEFAULT_ENTRYPOINT
            : text(input.execution.entrypoint, "execution.entrypoint"),
        language: artifact.data.language,
        memoryMiB:
          typeof input.execution.memoryMiB === "number"
            ? input.execution.memoryMiB
            : HOSTED_CODE_DEFAULT_MEMORY_MIB,
        network: input.execution.network === "sandbox" ? "sandbox" : "none",
        secretNames,
        sourceLanguage: artifact.data.sourceLanguage,
        timeoutMs:
          typeof input.execution.timeoutMs === "number"
            ? input.execution.timeoutMs
            : HOSTED_CODE_DEFAULT_TIMEOUT_MS,
        type: "hosted_code",
      },
      operations: credential ? [credential.operation] : [],
    };
  };
}
