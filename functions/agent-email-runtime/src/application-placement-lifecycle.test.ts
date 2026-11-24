import { testEndUserKeys } from "@deployments-ai/db/erasure-testing";
import {
  type AgentEmailDraftRecord,
  type AgentEmailMessageRecord,
  type AgentEmailPlacementRecord,
} from "@deployments-ai/agent-email";
import {
  inboxAttachmentRecord,
  inboxDraftRecord,
  inboxMessageRecord,
  inboxPlacementRecord,
  inboxResourceLocatorRecord,
  type DynamoDatabaseService,
  type PlatformRecord,
  type RecordKey,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { describe, expect, it } from "bun:test";
import type { AgentEmailApiInvocation } from "./api-handler.ts";
import { createDynamoAgentEmailApplicationService } from "./application-service.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const INBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const BINDING_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
const MESSAGE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB4";
const DRAFT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FBB";
const ATTACHMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FBC";
const NOW = "2026-07-25T12:00:00.000Z";

const scope = {
  environmentId: ENVIRONMENT_ID as Ulid,
  organizationId: ORGANIZATION_ID as Ulid,
  projectId: PROJECT_ID as Ulid,
};

function message(id: string, textBody: string): AgentEmailMessageRecord {
  return {
    attachments: [],
    bccAddresses: [],
    ccAddresses: [],
    createdAt: NOW,
    direction: "inbound",
    fromAddress: "sender@example.com",
    id,
    inboxId: INBOX_ID,
    organizationId: ORGANIZATION_ID,
    receivedAt: NOW,
    references: [],
    replyToAddresses: [],
    reprocessCount: 0,
    status: "received",
    subject: "Received",
    textBody,
    threadKey: id,
    toAddresses: ["agent@agents.example.com"],
    updatedAt: NOW,
  };
}

function draft(): AgentEmailDraftRecord {
  return {
    bccAddresses: [],
    ccAddresses: [],
    createdAt: NOW,
    id: DRAFT_ID,
    inboxId: INBOX_ID,
    metadata: {},
    organizationId: ORGANIZATION_ID,
    status: "draft",
    subject: "Draft",
    textBody: "Draft body",
    toAddresses: ["recipient@example.com"],
    updatedAt: NOW,
  };
}

function placement(overrides: Partial<AgentEmailPlacementRecord> = {}): AgentEmailPlacementRecord {
  return {
    createdAt: NOW,
    dedicatedPool: false,
    id: MESSAGE_ID,
    isDefault: false,
    name: "Primary",
    organizationId: ORGANIZATION_ID,
    provider: "ses",
    providerMetadata: { configurationSetName: "agent-email-primary" },
    region: "us-east-1",
    status: "active",
    updatedAt: NOW,
    ...overrides,
  };
}

function database(initial: readonly PlatformRecord[] = []) {
  const effectiveInitial =
    initial.some((record) => record.itemType === "inbox-policy") &&
    !initial.some((record) => record.itemType === "inbox-placement")
      ? [...initial, inboxPlacementRecord(scope, placement({ isDefault: true }))]
      : initial;
  const locatorRecords = effectiveInitial.flatMap((record) => {
    if (record.itemType === "inbox-message") {
      return [
        inboxResourceLocatorRecord(scope, {
          createdAt: record.data.createdAt,
          id: record.data.id,
          inboxId: record.data.inboxId,
          resourceType: "message",
        }),
      ];
    }
    if (record.itemType === "inbox-draft") {
      return [
        inboxResourceLocatorRecord(scope, {
          createdAt: record.data.createdAt,
          id: record.data.id,
          inboxId: record.data.inboxId,
          resourceType: "draft",
        }),
      ];
    }
    return [];
  });
  const records = [...effectiveInitial, ...locatorRecords];
  const gets: RecordKey[] = [];
  const queries: Record<string, unknown>[] = [];
  const transactions: TransactionOperation[][] = [];
  const service: DynamoDatabaseService = {
    deleteRecord: async (selected) => {
      const index = records.findIndex(
        (record) => record.pk === selected.pk && record.sk === selected.sk,
      );
      if (index >= 0) records.splice(index, 1);
    },
    getRecord: async (_table, key: RecordKey) => {
      gets.push(key);
      const found = records.find((record) => record.pk === key.pk && record.sk === key.sk);
      return found;
    },
    putRecord: async (record) => {
      const index = records.findIndex(
        (candidate) => candidate.pk === record.pk && candidate.sk === record.sk,
      );
      if (index >= 0) records[index] = record;
      else records.push(record);
    },
    queryRecords: async (_table, query) => {
      queries.push(query);
      const values = query.ExpressionAttributeValues as
        | { readonly ":pk"?: string; readonly ":sk"?: string }
        | undefined;
      const index =
        query.IndexName === "gsi1" ? "gsi1" : query.IndexName === "gsi2" ? "gsi2" : "base";
      const partitionField: "gsi1pk" | "gsi2pk" | "pk" =
        index === "gsi1" ? "gsi1pk" : index === "gsi2" ? "gsi2pk" : "pk";
      const sortField: "gsi1sk" | "gsi2sk" | "sk" =
        index === "gsi1" ? "gsi1sk" : index === "gsi2" ? "gsi2sk" : "sk";
      let items = records
        .filter(
          (record) =>
            record[partitionField] === values?.[":pk"] &&
            record[sortField]?.startsWith(values?.[":sk"] ?? ""),
        )
        .toSorted((left, right) => String(left[sortField]).localeCompare(String(right[sortField])));
      if (query.ScanIndexForward === false) items = items.toReversed();
      if (query.ExclusiveStartKey) {
        const cursor = query.ExclusiveStartKey[sortField];
        const cursorIndex = items.findIndex((record) => record[sortField] === cursor);
        if (cursorIndex >= 0) items = items.slice(cursorIndex + 1);
      }
      const limit = query.Limit ?? items.length;
      return {
        items: items.slice(0, limit),
        ...(items.length > limit
          ? {
              lastEvaluatedKey: {
                pk: items[limit - 1]!.pk,
                sk: items[limit - 1]!.sk,
              },
            }
          : {}),
      };
    },
    transactWrite: async (operations) => {
      transactions.push([...operations]);
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        const index = records.findIndex(
          (record) => record.pk === operation.record.pk && record.sk === operation.record.sk,
        );
        if (operation.kind === "delete") {
          if (index >= 0) records.splice(index, 1);
        } else if (index >= 0) {
          records[index] = operation.record;
        } else {
          records.push(operation.record);
        }
      }
    },
  };
  return { gets, queries, records, service, transactions };
}

function invocation(
  body: Readonly<Record<string, unknown>> | undefined,
  parameters: Readonly<Record<string, string>> = {},
): AgentEmailApiInvocation {
  return {
    body,
    identity: {
      permissions: ["agent-email:*"],
      principalId: "test-principal",
      scope,
    },
    parameters,
    query: {},
    scope,
  };
}

function ids(values: readonly string[]) {
  let index = 0;
  return () => values[index++] ?? EVENT_ID;
}

describe("Dynamo-backed agent email application service", () => {
  it("uses direct resource locators and a bounded attachment index lookup", async () => {
    const storedMessage = inboxMessageRecord(scope, message(MESSAGE_ID, "body"), []);
    const storedDraft = inboxDraftRecord(scope, draft(), []);
    const storedAttachment = inboxAttachmentRecord(
      scope,
      MESSAGE_ID as Ulid,
      {
        bucket: "agent-email",
        byteSize: 4,
        contentType: "text/plain",
        disposition: "attachment",
        fileName: "note.txt",
        id: ATTACHMENT_ID as Ulid,
        key: `attachments/${MESSAGE_ID}/note.txt`,
        sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      },
      NOW,
      0,
    );
    const memory = database([storedMessage, storedDraft, storedAttachment]);
    const service = createDynamoAgentEmailApplicationService({
      blobs: {
        delete: async () => {},
        get: async () => new Uint8Array(),
        put: async () => {},
        signedGetUrl: async () => "https://example.invalid/attachment",
      },
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute("getMessage", invocation(undefined, { messageId: MESSAGE_ID })),
    ).resolves.toMatchObject({ id: MESSAGE_ID });
    expect(
      service.execute("getDraft", invocation(undefined, { draftId: DRAFT_ID })),
    ).resolves.toMatchObject({ id: DRAFT_ID });
    expect(
      service.execute(
        "createAttachmentAccessUrl",
        invocation(undefined, { attachmentId: ATTACHMENT_ID }),
      ),
    ).resolves.toMatchObject({ url: "https://example.invalid/attachment" });

    const locators = memory.records.filter(
      (record) => record.itemType === "inbox-resource-locator",
    );
    expect(memory.gets).toEqual(
      expect.arrayContaining([
        ...locators.map(({ pk, sk }) => ({ pk, sk })),
        { pk: storedMessage.pk, sk: storedMessage.sk },
        { pk: storedDraft.pk, sk: storedDraft.sk },
      ]),
    );
    expect(memory.queries).toContainEqual(
      expect.objectContaining({
        ExpressionAttributeValues: {
          ":pk": `ORG#${ORGANIZATION_ID}#INBOX-MESSAGE#${MESSAGE_ID}`,
          ":sk": "INBOX-ATTACHMENT#",
        },
      }),
    );
    expect(memory.queries).toContainEqual({
      ExpressionAttributeNames: { "#pk": "gsi1pk", "#sk": "gsi1sk" },
      ExpressionAttributeValues: {
        ":pk": `ORG#${ORGANIZATION_ID}#INBOX-ATTACHMENT#${ATTACHMENT_ID}`,
        ":sk": `INBOX-ATTACHMENT#${ATTACHMENT_ID}`,
      },
      IndexName: "gsi1",
      KeyConditionExpression: "#pk = :pk AND #sk = :sk",
      Limit: 2,
    });
    expect(memory.queries).not.toContainEqual(
      expect.objectContaining({
        ExpressionAttributeValues: expect.objectContaining({
          ":pk": `ENV#${ENVIRONMENT_ID}`,
        }),
      }),
    );
  });

  it("reserves a placement before provisioning external SES resources", async () => {
    const memory = database();
    let reservationVisible = false;
    const service = createDynamoAgentEmailApplicationService({
      createId: ids([MESSAGE_ID]),
      database: memory.service,
      now: () => new Date(NOW),
      placementProvisioner: {
        deprovision: async (placement) => placement,
        prepareReservation: (placement) => ({
          ...placement,
          providerMetadata: { poolName: "reserved-pool" },
        }),
        provision: async (placement) => {
          reservationVisible = memory.records.some(
            (record) =>
              record.itemType === "inbox-placement" &&
              record.data.id === placement.id &&
              record.data.providerMetadata.poolName === "reserved-pool",
          );
          return { ...placement, status: "active", updatedAt: NOW };
        },
        reconcile: async (placement) => placement,
      },
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute("createPlacement", invocation({ name: "Primary", region: "us-east-1" })),
    ).resolves.toMatchObject({ id: MESSAGE_ID, status: "active" });
    expect(reservationVisible).toBe(true);
  });

  it("scopes deterministic placement IDs to the idempotency principal", async () => {
    const memory = database();
    const service = createDynamoAgentEmailApplicationService({
      database: memory.service,
      now: () => new Date(NOW),
      placementProvisioner: {
        deprovision: async (candidate) => candidate,
        prepareReservation: (candidate) => candidate,
        provision: async (candidate) => ({ ...candidate, status: "active" }),
        reconcile: async (candidate) => candidate,
      },
      endUserKeys: testEndUserKeys,
    });
    const request = invocation({ name: "Regional", region: "us-east-1" });
    const first = (await service.execute("createPlacement", {
      ...request,
      idempotencyKey: "shared-key",
      identity: { ...request.identity, principalId: "admin-a" },
    })) as { readonly id: string };
    const second = (await service.execute("createPlacement", {
      ...request,
      idempotencyKey: "shared-key",
      identity: { ...request.identity, principalId: "admin-b" },
    })) as { readonly id: string };

    expect(first.id).not.toBe(second.id);
  });

  it("rejects default placements outside the OpenTofu-managed hosted identity region", async () => {
    const memory = database([
      inboxPlacementRecord(scope, placement({ isDefault: false, region: "us-west-2" })),
    ]);
    let providerCalls = 0;
    const service = createDynamoAgentEmailApplicationService({
      database: memory.service,
      hostedDomainRegion: "us-east-1",
      now: () => new Date(NOW),
      placementProvisioner: {
        deprovision: async (candidate) => candidate,
        prepareReservation: (candidate) => candidate,
        provision: async (candidate) => {
          providerCalls += 1;
          return candidate;
        },
        reconcile: async (candidate) => {
          providerCalls += 1;
          return candidate;
        },
      },
      endUserKeys: testEndUserKeys,
    });

    for (const body of [
      { isDefault: true, name: "Wrong primary", region: "us-west-2" },
      {
        isDefault: true,
        name: "Unsupported failover",
        region: "us-east-1",
        secondaryRegion: "us-west-2",
      },
    ]) {
      expect(service.execute("createPlacement", invocation(body))).rejects.toMatchObject({
        code: "hosted_domain_region_unsupported",
        status: 400,
      });
    }
    expect(
      service.execute(
        "updatePlacement",
        invocation({ isDefault: true }, { placementId: MESSAGE_ID }),
      ),
    ).rejects.toMatchObject({
      code: "hosted_domain_region_unsupported",
      status: 400,
    });
    expect(providerCalls).toBe(0);
  });

  it("reuses a failed placement reservation and releases its default claim", async () => {
    const memory = database();
    let attempts = 0;
    let cleanups = 0;
    const service = createDynamoAgentEmailApplicationService({
      database: memory.service,
      now: () => new Date(NOW),
      placementProvisioner: {
        deprovision: async (candidate) => {
          cleanups += 1;
          return { ...candidate, isDefault: false, status: "disabled" };
        },
        prepareReservation: (candidate) => candidate,
        provision: async (candidate) => {
          attempts += 1;
          if (attempts === 1) throw new Error("SES provisioning failed");
          return { ...candidate, status: "active" };
        },
        reconcile: async (candidate) => candidate,
      },
      endUserKeys: testEndUserKeys,
    });
    const request = {
      ...invocation({ isDefault: true, name: "Primary", region: "us-east-1" }),
      idempotencyKey: "placement-request",
    };

    expect(service.execute("createPlacement", request)).rejects.toThrow("SES provisioning failed");
    const failed = memory.records.find(
      (record) => record.itemType === "inbox-placement" && record.data.status === "failed",
    );
    expect(failed?.itemType === "inbox-placement" ? failed.data.isDefault : undefined).toBe(false);

    const retried = await service.execute("createPlacement", request);
    expect(retried).toMatchObject({
      id: failed?.itemType === "inbox-placement" ? failed.data.id : undefined,
      isDefault: true,
      status: "active",
    });
    expect({ attempts, cleanups }).toEqual({ attempts: 2, cleanups: 1 });
  });

  it("deprovisions provider resources when disabling a placement", async () => {
    const memory = database([inboxPlacementRecord(scope, placement({ isDefault: true }))]);
    let deprovisioned = false;
    let transitionVisible = false;
    const service = createDynamoAgentEmailApplicationService({
      database: memory.service,
      now: () => new Date(NOW),
      placementProvisioner: {
        deprovision: async (candidate) => {
          deprovisioned = true;
          transitionVisible = memory.records.some(
            (record) =>
              record.itemType === "inbox-placement" &&
              record.data.id === candidate.id &&
              record.data.status === "deprovisioning",
          );
          return {
            ...candidate,
            providerMetadata: {},
            status: "disabled",
            updatedAt: NOW,
          };
        },
        prepareReservation: (candidate) => candidate,
        provision: async (candidate) => candidate,
        reconcile: async (candidate) => candidate,
      },
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute(
        "updatePlacement",
        invocation({ status: "disabled" }, { placementId: MESSAGE_ID }),
      ),
    ).resolves.toMatchObject({
      id: MESSAGE_ID,
      isDefault: false,
      providerMetadata: {},
      status: "disabled",
    });
    expect(deprovisioned).toBe(true);
    expect(transitionVisible).toBe(true);
  });

  it("persists reconciliation state before mutating SES placement resources", async () => {
    const memory = database([inboxPlacementRecord(scope, placement())]);
    let transitionVisible = false;
    const service = createDynamoAgentEmailApplicationService({
      database: memory.service,
      now: () => new Date(NOW),
      placementProvisioner: {
        deprovision: async (candidate) => candidate,
        prepareReservation: (candidate) => ({
          ...candidate,
          providerMetadata: { ...candidate.providerMetadata, poolName: "reserved-pool" },
        }),
        provision: async (candidate) => candidate,
        reconcile: async (candidate) => {
          transitionVisible = memory.records.some(
            (record) =>
              record.itemType === "inbox-placement" &&
              record.data.id === candidate.id &&
              record.data.status === "reconciling" &&
              record.data.providerMetadata.poolName === "reserved-pool",
          );
          return { ...candidate, status: "active" };
        },
      },
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute(
        "updatePlacement",
        invocation({ dedicatedPool: true, name: "Updated placement" }, { placementId: MESSAGE_ID }),
      ),
    ).resolves.toMatchObject({ dedicatedPool: true, name: "Updated placement", status: "active" });
    expect(transitionVisible).toBe(true);
  });

  it("rejects default placement promotion before provider reconciliation", async () => {
    const memory = database([
      inboxPlacementRecord(scope, placement()),
      inboxPlacementRecord(scope, placement({ id: BINDING_ID, isDefault: true })),
    ]);
    let reconciled = false;
    const service = createDynamoAgentEmailApplicationService({
      database: memory.service,
      now: () => new Date(NOW),
      placementProvisioner: {
        deprovision: async (candidate) => candidate,
        prepareReservation: (candidate) => candidate,
        provision: async (candidate) => candidate,
        reconcile: async (candidate) => {
          reconciled = true;
          return candidate;
        },
      },
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute(
        "updatePlacement",
        invocation({ isDefault: true }, { placementId: MESSAGE_ID }),
      ),
    ).rejects.toMatchObject({
      code: "default_placement_conflict",
      status: 409,
    });
    expect(reconciled).toBe(false);
  });
});
