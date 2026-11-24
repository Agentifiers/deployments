import { TEAMS_DEFAULT_SERVICE_URL } from "@deployments-ai/channel-adapters";
import {
  ChannelBindingRecord,
  CredentialVaultEntryRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { deliveryPayload } from "./channel-bindings.ts";
import type { Binding } from "./channel-validation.ts";
import { createChannelBinding, updateChannelBinding, verifyChannelBinding } from "./channels.ts";
import {
  deployment,
  deploymentId,
  ids,
  memoryDatabase,
  now,
  principal,
} from "./runtime-lifecycle.fixture.ts";
import type { RuntimeApiDependencies } from "./runtime-support.ts";

const TENANT_ID = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const CHANNEL_CONVERSATION = "19:abc@thread.tacv2";
const createInput = {
  agentDefinitionId: ids[5]!,
  agentDeploymentId: deploymentId,
  channel: "teams",
  externalAccountId: "00000000-0000-4000-8000-000000000001",
  externalChannelId: CHANNEL_CONVERSATION,
  externalWorkspaceId: TENANT_ID,
  idempotencyKey: "teams-binding",
  provider: "teams_bot_framework",
} as const;

function fixture() {
  const memory = memoryDatabase([deployment()]);
  let generated = 10;
  const dependencies = {
    database: memory.database,
    generateId: async () => ids[generated++]!,
    now: () => now,
  } as unknown as RuntimeApiDependencies;
  const put = (record: PlatformRecord) => memory.records.set(`${record.pk}\n${record.sk}`, record);
  const attachCredential = (binding: Binding) => {
    const credential = Schema.decodeUnknownSync(CredentialVaultEntryRecord)(
      withCanonicalRecordKeys({
        data: {
          ...principal().scope,
          algorithm: "AES-256-GCM" as const,
          authTag: "auth-tag",
          ciphertext: "ciphertext",
          createdAt: now.toISOString(),
          encryptedDataKey: "encrypted-data-key",
          encryptionContextHash: "context-hash",
          generation: 1,
          id: ids[30]!,
          iv: "initialization-vector",
          kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/test",
          ownerId: binding.data.id,
          ownerType: "channel-binding" as const,
          purpose: "channel-runtime",
          status: "active" as const,
          updatedAt: now.toISOString(),
          version: 0,
        },
        itemType: "credential-vault-entry" as const,
      }),
    );
    const attached = Schema.decodeUnknownSync(ChannelBindingRecord)(
      withCanonicalRecordKeys({
        data: {
          ...binding.data,
          credentialRef: {
            credentialId: credential.data.id,
            generation: credential.data.generation,
            store: "dynamodb-kms" as const,
          },
          version: binding.data.version + 1,
        },
        itemType: "channel-binding" as const,
      }),
    );
    put(credential);
    put(attached);
    return attached;
  };
  return { attachCredential, dependencies, memory, put };
}

describe("Teams channel bindings", () => {
  test("normalizes the Teams agent identity and rejects invalid identities", async () => {
    const { dependencies } = fixture();
    const caller = principal();

    const created = await createChannelBinding(
      caller,
      { ...createInput, metadata: { teamsAgentIdentity: { displayName: "  Rex  " }, team: "a" } },
      dependencies,
    );

    expect(created.data).toMatchObject({
      channel: "teams",
      metadata: { team: "a", teamsAgentIdentity: { displayName: "Rex" } },
      provider: "teams_bot_framework",
      status: "disabled",
    });
    for (const teamsAgentIdentity of [
      { displayName: "x".repeat(81) },
      { displayName: "Rex\u0007" },
      "Rex",
    ]) {
      expect(
        createChannelBinding(
          caller,
          { ...createInput, idempotencyKey: "invalid-teams", metadata: { teamsAgentIdentity } },
          dependencies,
        ),
      ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    }
    expect(
      updateChannelBinding(
        caller,
        created.data.id,
        { metadata: { teamsAgentIdentity: { displayName: "" } } },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
  });

  test("requires the tenant pin before verification", async () => {
    const { attachCredential, dependencies } = fixture();
    const caller = principal();
    const { externalWorkspaceId: _tenantPin, ...unpinned } = createInput;
    const created = await createChannelBinding(caller, unpinned, dependencies);
    attachCredential(created);

    expect(verifyChannelBinding(caller, created.data.id, dependencies)).rejects.toMatchObject({
      code: "binding_incomplete",
      message: "Channel binding has no external workspace pin.",
      status: 409,
    });
  });

  test("refuses to verify a binding whose stored identity is invalid", async () => {
    const { attachCredential, dependencies, put } = fixture();
    const caller = principal();
    const created = attachCredential(await createChannelBinding(caller, createInput, dependencies));
    put({
      ...created,
      data: { ...created.data, metadata: { teamsAgentIdentity: { displayName: "" } } },
    } as PlatformRecord);

    expect(verifyChannelBinding(caller, created.data.id, dependencies)).rejects.toMatchObject({
      code: "binding_identity_invalid",
      status: 409,
    });
  });

  test("keeps a verified binding active when only its identity label changes", async () => {
    const { attachCredential, dependencies } = fixture();
    const caller = principal();
    const created = attachCredential(
      await createChannelBinding(
        caller,
        { ...createInput, metadata: { teamsAgentIdentity: { displayName: "Rex" } } },
        dependencies,
      ),
    );

    const verified = await verifyChannelBinding(caller, created.data.id, dependencies);
    expect(verified.data).toMatchObject({ lastVerifiedAt: now.toISOString(), status: "active" });

    const relabeled = await updateChannelBinding(
      caller,
      created.data.id,
      { metadata: { teamsAgentIdentity: { displayName: "Nova" } } },
      dependencies,
    );
    expect(relabeled.data).toMatchObject({
      lastVerifiedAt: now.toISOString(),
      metadata: { teamsAgentIdentity: { displayName: "Nova" } },
      status: "active",
    });
  });
});

describe("Teams explicit delivery payloads", () => {
  const teamsBinding = (metadata?: Readonly<Record<string, unknown>>) =>
    ({ data: { provider: "teams_bot_framework", ...(metadata ? { metadata } : {}) } }) as Binding;

  test("posts into the thread named by a Teams thread key with the identity label", () => {
    expect(
      deliveryPayload(
        teamsBinding({ teamsAgentIdentity: { displayName: "Rex" } }),
        "Deployment complete.",
        CHANNEL_CONVERSATION,
        `teams:${TENANT_ID}:thread:${CHANNEL_CONVERSATION};messageid=1700000000001`,
      ),
    ).toEqual({
      conversationId: `${CHANNEL_CONVERSATION};messageid=1700000000001`,
      serviceUrl: TEAMS_DEFAULT_SERVICE_URL,
      text: "**Rex**\n\nDeployment complete.",
    });
  });

  test("falls back to the binding conversation for non-Teams thread keys", () => {
    expect(
      deliveryPayload(teamsBinding(), "Hello", CHANNEL_CONVERSATION, "operator-thread"),
    ).toEqual({
      conversationId: CHANNEL_CONVERSATION,
      serviceUrl: TEAMS_DEFAULT_SERVICE_URL,
      text: "Hello",
    });
  });

  test("rejects deliveries for bindings with invalid identity metadata", () => {
    expect(() =>
      deliveryPayload(
        teamsBinding({ teamsAgentIdentity: { displayName: "" } }),
        "Hello",
        CHANNEL_CONVERSATION,
        "operator-thread",
      ),
    ).toThrow(expect.objectContaining({ code: "binding_identity_invalid", status: 409 }));
  });
});
