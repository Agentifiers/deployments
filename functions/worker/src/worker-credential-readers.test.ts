import { describe, expect, test } from "bun:test";
import type { CredentialVaultReadRequest } from "@deployments-ai/credential-vault";
import type { DynamoDatabaseService, PlatformRecord, Ulid } from "@deployments-ai/db";
import { createWorkerCredentialReaders } from "./worker-credential-readers.ts";

const [organizationId, projectId, environmentId, credentialId, ownerId, eventId] = Array.from(
  { length: 6 },
  (_, index) => `01J000000000000000000000${String(index).padStart(2, "0")}` as Ulid,
) as [Ulid, Ulid, Ulid, Ulid, Ulid, Ulid];
const reference = { credentialId, generation: 3, store: "dynamodb-kms" as const };
const secret = {
  createdAt: "2026-01-01T00:00:00.000Z",
  generation: 3,
  schemaVersion: 1 as const,
  updatedAt: "2026-01-01T00:00:00.000Z",
  values: { token: "xoxb-secret" },
};

function readers(options: { readonly failAudit?: boolean } = {}) {
  const vaultReads: CredentialVaultReadRequest[] = [];
  const writes: { readonly condition: string | undefined; readonly record: PlatformRecord }[] = [];
  const database: DynamoDatabaseService = {
    deleteRecord: async () => {},
    getRecord: async () => undefined,
    putRecord: async (record, condition) => {
      if (options.failAudit) throw new Error("audit write failed");
      writes.push({ condition, record });
    },
    queryRecords: async () => ({ items: [] }),
    transactWrite: async () => {},
  };
  const created = createWorkerCredentialReaders({
    credentialVault: {
      read: async (request) => {
        vaultReads.push(request);
        return secret;
      },
    },
    database,
    generateId: async () => eventId,
  });
  return { ...created, vaultReads, writes };
}

const scope = { environmentId, organizationId, projectId, reference };

describe("worker credential readers", () => {
  test("each reader requests its owner identity and audits the read before returning", async () => {
    const subject = readers();
    const results = [
      await subject.readProviderConnectionCredential({
        ...scope,
        connectionId: ownerId,
        purpose: "provider-api",
      }),
      await subject.readMcpServerCredential({ ...scope, serverId: ownerId }),
      await subject.readToolAdapterCredential({ ...scope, toolAdapterId: ownerId }),
      await subject.readChannelCredential({ ...scope, bindingId: ownerId }),
    ];

    expect(results).toEqual([secret, secret, secret, { token: "xoxb-secret" }]);
    expect(subject.vaultReads.map((request) => request.expectedIdentity)).toEqual([
      { ownerId, ownerType: "provider-connection", projectId, purpose: "provider-api" },
      { ownerId, ownerType: "mcp-server", projectId, purpose: "mcp-server-auth" },
      { ownerId, ownerType: "tool-adapter", projectId, purpose: "extension-callback-auth" },
      { ownerId, ownerType: "channel-binding", projectId, purpose: "channel-runtime" },
    ]);
    expect(subject.writes).toHaveLength(4);
    for (const { condition, record } of subject.writes) {
      expect(condition).toBe("attribute_not_exists(pk) AND attribute_not_exists(sk)");
      expect(record).toMatchObject({
        data: {
          action: "credential.read",
          actor: { type: "worker" },
          environmentId,
          eventId,
          organizationId,
          projectId,
          resourceId: credentialId,
          resourceType: "credential-vault-entry",
        },
        itemType: "audit-event",
      });
    }
  });

  test("withholds native Slack channel secret values when the audit write fails", () => {
    const subject = readers({ failAudit: true });

    expect(subject.readChannelCredential({ ...scope, bindingId: ownerId })).rejects.toThrow(
      "audit write failed",
    );
  });
});
