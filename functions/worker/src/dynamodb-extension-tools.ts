import type {
  CredentialVaultReference,
  CredentialVaultSecretDocument,
} from "@deployments-ai/credential-vault";
import { Keys, type DynamoDatabaseService, type Ulid, workerPersistence } from "@deployments-ai/db";
import { toolAdapterDefinitionFromRecord, type ToolAdapterDefinition } from "@deployments-ai/tools";
import { pinnedHostedCodeDefinition } from "./hosted-code/pinned-definition.ts";
import type { RuntimeToolBindingRequest } from "./runtime-tools.ts";

type Context = Pick<RuntimeToolBindingRequest, "environmentId" | "organizationId" | "projectId"> &
  Partial<Pick<RuntimeToolBindingRequest, "agentReleaseId" | "executionBindingId">>;

export function createDynamoExtensionToolResolver(
  database: DynamoDatabaseService,
  options?: {
    readonly readCredential: (input: {
      readonly environmentId: Ulid;
      readonly organizationId: Ulid;
      readonly projectId: Ulid;
      readonly reference: CredentialVaultReference;
      readonly toolAdapterId: Ulid;
    }) => Promise<CredentialVaultSecretDocument>;
  },
) {
  return async (toolName: string, context: Context): Promise<ToolAdapterDefinition | undefined> => {
    const namespace = `environment:${context.environmentId}:tool-adapter-name`;
    const claim = await workerPersistence.read(
      database,
      "control",
      Keys.control.uniqueClaim(namespace, toolName),
      true,
    );
    if (
      !claim ||
      claim.itemType !== "unique-claim" ||
      claim.data.namespace !== namespace ||
      claim.data.value !== toolName ||
      claim.data.ownerItemType !== "tool-adapter" ||
      claim.data.ownerTable !== "control"
    ) {
      return undefined;
    }
    const authoritative = await workerPersistence.read(
      database,
      "control",
      { pk: claim.data.ownerPk, sk: claim.data.ownerSk },
      true,
    );
    if (
      !authoritative ||
      authoritative.itemType !== "tool-adapter" ||
      authoritative.data.id !== claim.data.ownerId ||
      authoritative.data.name !== toolName ||
      authoritative.data.organizationId !== context.organizationId ||
      authoritative.data.projectId !== context.projectId ||
      authoritative.data.environmentId !== context.environmentId ||
      authoritative.data.status !== "active"
    ) {
      return undefined;
    }
    const adapter = authoritative;
    const definition = toolAdapterDefinitionFromRecord(adapter);
    if (adapter.data.execution.type === "hosted_code") {
      return pinnedHostedCodeDefinition(database, adapter, definition, context);
    }
    if (definition.execution?.type !== "http_callback") return definition;
    const reference = adapter.data.authSecretRef;
    if (!options || !reference || !("store" in reference) || reference.store !== "dynamodb-kms") {
      throw new Error(`HTTP callback extension ${toolName} has no vault authentication.`);
    }
    const secret = await options.readCredential({
      environmentId: adapter.data.environmentId,
      organizationId: adapter.data.organizationId,
      projectId: adapter.data.projectId,
      reference,
      toolAdapterId: adapter.data.id,
    });
    const authorizationHeader = secret.values.authorization?.trim();
    if (!authorizationHeader) {
      throw new Error(`HTTP callback extension ${toolName} has invalid vault authentication.`);
    }
    return {
      ...definition,
      execution: {
        ...definition.execution,
        authorizationHeader,
        credentialGeneration: reference.generation,
      },
    };
  };
}
