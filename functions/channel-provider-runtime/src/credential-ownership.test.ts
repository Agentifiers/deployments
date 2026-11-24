import { describe, expect, test } from "bun:test";
import {
  ChannelBindingRecord,
  ProviderConnectionRecord,
  uniqueClaimRequirements,
  withCanonicalRecordKeys,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";

import { updatedOwner } from "./credential-ownership.ts";

const ids = Array.from(
  { length: 5 },
  (_, index) => `01ARZ3NDEKTSV4RRFFQ69G5F${String(index).padStart(2, "0")}`,
) as Ulid[];

describe("credential ownership projections", () => {
  test("disables custom-identity Slack bindings for verification after credential rotation", () => {
    const owner = Schema.decodeUnknownSync(ChannelBindingRecord)(
      withCanonicalRecordKeys({
        itemType: "channel-binding" as const,
        data: {
          agentDefinitionId: ids[3]!,
          agentDeploymentId: ids[4]!,
          channel: "slack",
          createdAt: "2026-07-24T00:00:00.000Z",
          credentialRef: { credentialId: ids[4]!, generation: 1, store: "dynamodb-kms" as const },
          environmentId: ids[2]!,
          externalChannelId: "C123",
          externalWorkspaceId: "T123",
          id: ids[3]!,
          lastVerifiedAt: "2026-07-24T00:30:00.000Z",
          metadata: { slackAgentIdentity: { username: "Release Agent" } },
          organizationId: ids[0]!,
          projectId: ids[1]!,
          provider: "slack_edge",
          status: "active" as const,
          updatedAt: "2026-07-24T00:30:00.000Z",
          version: 1,
        },
      }),
    );

    const replacement = updatedOwner(
      owner,
      {
        action: "rotated",
        ownerId: owner.data.id,
        ownerType: "channel-binding",
        prepared: {
          operation: {
            kind: "put",
            previousRecord: {
              itemType: "credential-vault-entry",
              data: { generation: 1, id: ids[4]! },
            } as never,
            record: {} as never,
          },
          reference: { credentialId: ids[4]!, generation: 2, store: "dynamodb-kms" },
        },
        scope: {
          environmentId: ids[2]!,
          organizationId: ids[0]!,
          projectId: ids[1]!,
        },
      },
      "2026-07-24T01:00:00.000Z",
    );

    expect(replacement.data).toMatchObject({
      credentialRef: { credentialId: ids[4]!, generation: 2, store: "dynamodb-kms" },
      status: "disabled",
      updatedAt: "2026-07-24T01:00:00.000Z",
      version: 2,
    });
    expect(replacement.data).not.toHaveProperty("lastVerifiedAt");
  });

  test("updates OAuth scopes and resource with the rotated credential reference", () => {
    const owner = Schema.decodeUnknownSync(ProviderConnectionRecord)(
      withCanonicalRecordKeys({
        itemType: "provider-connection" as const,
        data: {
          authMethod: "oauth",
          createdAt: "2026-07-24T00:00:00.000Z",
          credentialRef: { credentialId: ids[4]!, generation: 1, store: "dynamodb-kms" as const },
          environmentId: ids[2]!,
          externalAccountId: "account-1",
          id: ids[3]!,
          oauthResource: "https://old.example.com",
          organizationId: ids[0]!,
          projectId: ids[1]!,
          providerKey: "salesforce",
          scopes: ["old"],
          status: "active" as const,
          updatedAt: "2026-07-24T00:00:00.000Z",
          version: 1,
        },
      }),
    );
    const replacement = updatedOwner(
      owner,
      {
        action: "rotated",
        ownerId: owner.data.id,
        ownerType: "provider-connection",
        prepared: {
          operation: {
            kind: "put",
            previousRecord: {
              itemType: "credential-vault-entry",
              data: { generation: 1, id: ids[4]! },
            } as never,
            record: {} as never,
          },
          reference: { credentialId: ids[4]!, generation: 2, store: "dynamodb-kms" },
        },
        providerConnectionUpdate: {
          externalAccountId: "account-2",
          externalAccountName: "Production account",
          lastVerifiedAt: "2026-07-24T01:00:00.000Z",
          oauthResource: "https://new.example.com",
          scopes: ["new"],
          status: "reauthorization-required",
        },
        scope: {
          environmentId: ids[2]!,
          organizationId: ids[0]!,
          projectId: ids[1]!,
        },
      },
      "2026-07-24T01:00:00.000Z",
    );

    expect(replacement.data).toMatchObject({
      credentialRef: { credentialId: ids[4]!, generation: 2, store: "dynamodb-kms" },
      externalAccountId: "account-2",
      externalAccountName: "Production account",
      lastVerifiedAt: "2026-07-24T01:00:00.000Z",
      oauthResource: "https://new.example.com",
      scopes: ["new"],
      status: "reauthorization-required",
      version: 2,
    });
  });

  test("disconnects OAuth connections so their external account claim can be reused", () => {
    const owner = Schema.decodeUnknownSync(ProviderConnectionRecord)(
      withCanonicalRecordKeys({
        itemType: "provider-connection" as const,
        data: {
          authMethod: "oauth",
          createdAt: "2026-07-24T00:00:00.000Z",
          credentialRef: { credentialId: ids[4]!, generation: 1, store: "dynamodb-kms" as const },
          environmentId: ids[2]!,
          externalAccountId: "account-1",
          id: ids[3]!,
          organizationId: ids[0]!,
          projectId: ids[1]!,
          providerKey: "salesforce",
          scopes: ["read"],
          status: "active" as const,
          updatedAt: "2026-07-24T00:00:00.000Z",
          version: 1,
        },
      }),
    );
    const disconnected = updatedOwner(
      owner,
      {
        action: "revoked",
        ownerId: owner.data.id,
        ownerType: "provider-connection",
        prepared: {
          operation: {
            kind: "put",
            previousRecord: {
              itemType: "credential-vault-entry",
              data: { generation: 1, id: ids[4]! },
            } as never,
            record: {} as never,
          },
          reference: { credentialId: ids[4]!, generation: 1, store: "dynamodb-kms" },
        },
        scope: {
          environmentId: ids[2]!,
          organizationId: ids[0]!,
          projectId: ids[1]!,
        },
      },
      "2026-07-24T01:00:00.000Z",
    );

    if (disconnected.itemType !== "provider-connection") {
      throw new Error("Expected a provider connection replacement.");
    }
    expect(disconnected.data.status).toBe("disconnected");
    expect(uniqueClaimRequirements(owner)).toHaveLength(1);
    expect(uniqueClaimRequirements(disconnected)).toEqual([]);
  });
});
