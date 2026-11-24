import type { BrainSource } from "@deployments-ai/brains";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import { key } from "../keys.ts";
import type { PlatformRecord } from "../records/index.ts";

/**
 * GitHub is a `vendor_mcp` provider: its connections carry the vendor capability scopes and the
 * GitHub OAuth access token, which the Brain connector uses directly against the GitHub REST API.
 */
const GITHUB_BRAIN_READ_CAPABILITY = "tools:read";

export async function githubConnectionAuthorization(
  database: DynamoDatabaseService,
  source: BrainSource,
): Promise<{
  readonly condition: TransactionOperation;
  readonly connection: Extract<PlatformRecord, { readonly itemType: "provider-connection" }>;
}> {
  if (!source.connectionId || !source.environmentId || !source.projectId) {
    throw new TypeError("GitHub Brain sources require a scoped provider connection.");
  }
  const connection = await database.getRecord(
    "control",
    {
      pk: key("ORG", source.organizationId, "ENV", source.environmentId),
      sk: key("PROVIDER-CONNECTION", source.connectionId),
    },
    true,
  );
  if (
    connection?.itemType !== "provider-connection" ||
    connection.data.status !== "active" ||
    connection.data.providerKey !== "github" ||
    connection.data.organizationId !== source.organizationId ||
    connection.data.projectId !== source.projectId ||
    connection.data.environmentId !== source.environmentId ||
    connection.data.authMethod !== "oauth" ||
    connection.data.credentialRef === undefined ||
    !("generation" in connection.data.credentialRef) ||
    !connection.data.scopes.includes(GITHUB_BRAIN_READ_CAPABILITY)
  ) {
    throw new TypeError(
      `GitHub Brain sources require an active GitHub connection granting ${GITHUB_BRAIN_READ_CAPABILITY}.`,
    );
  }
  return {
    condition: {
      conditionExpression:
        "#itemType = :itemType AND #data.#status = :active AND #data.#version = :version AND #data.#providerKey = :github AND #data.#organizationId = :organizationId AND #data.#projectId = :projectId AND #data.#environmentId = :environmentId AND attribute_exists(#data.#credentialRef)",
      expressionAttributeNames: {
        "#credentialRef": "credentialRef",
        "#data": "data",
        "#environmentId": "environmentId",
        "#itemType": "itemType",
        "#organizationId": "organizationId",
        "#projectId": "projectId",
        "#providerKey": "providerKey",
        "#status": "status",
        "#version": "version",
      },
      expressionAttributeValues: {
        ":active": "active",
        ":environmentId": source.environmentId,
        ":github": "github",
        ":itemType": "provider-connection",
        ":organizationId": source.organizationId,
        ":projectId": source.projectId,
        ":version": connection.data.version,
      },
      key: { pk: connection.pk, sk: connection.sk },
      kind: "condition-check",
      table: "control",
    },
    connection,
  };
}
