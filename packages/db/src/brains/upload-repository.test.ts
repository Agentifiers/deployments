import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "bun:test";
import type {
  Brain,
  BrainGrant,
  BrainSource,
  BrainUploadLease,
  BrainUploadTicket,
} from "@deployments-ai/brains";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import { makeDynamoDatabase } from "../dynamo-database.ts";
import { key } from "../keys.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import { fakeDynamoDocumentClient } from "../testing/dynamo-document-client.fixture.ts";
import {
  brainGrantPlatformRecord,
  brainPlatformRecord,
  brainSourcePlatformRecord,
} from "./record-mapping.ts";
import { DEFAULT_BRAIN_UPLOAD_QUOTAS } from "./upload-quotas.ts";
import { makeBrainUploadRepository } from "./upload-repository.ts";
import { expireBrainUploadTicket } from "./upload-expiry.ts";

const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const brainId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const principalId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const sourceId = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const grantId = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const ticketId = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const leaseId = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
const eventId = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
const timestamp = "2026-07-30T12:00:00.000Z";
const expiresAt = "2026-07-30T12:05:00.000Z";

const brain: Brain = {
  createdAt: timestamp,
  createdByPrincipalId: principalId,
  id: brainId,
  kind: "company",
  maintenancePolicy: {},
  name: "Engineering",
  organizationId,
  ownershipGeneration: 0,
  retrievalPolicy: {},
  schemaVersion: 1,
  sensitivity: "internal",
  slug: "engineering",
  status: "active",
  updatedAt: timestamp,
  updatedByPrincipalId: principalId,
  version: 0,
};

const grant: BrainGrant = {
  brainId,
  brainKind: "company",
  createdAt: timestamp,
  grantedByPrincipalId: principalId,
  id: grantId,
  organizationId,
  permission: "writer",
  status: "active",
  target: { principalId, type: "principal" },
  updatedAt: timestamp,
  version: 0,
};

const source: BrainSource = {
  brainId,
  createdAt: timestamp,
  createdByPrincipalId: principalId,
  id: sourceId,
  kind: "upload",
  name: "Uploads",
  organizationId,
  status: "active",
  updatedAt: timestamp,
  updatedByPrincipalId: principalId,
  version: 0,
};

const ticket: BrainUploadTicket = {
  brainId,
  createdAt: timestamp,
  createdByPrincipalId: principalId,
  expectedByteSize: 3,
  expectedContentHash: "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  expiresAt,
  id: ticketId,
  mediaType: "text/plain",
  objectKey: `organizations/${organizationId}/brains/${brainId}/uploads/${ticketId}`,
  organizationId,
  sourceId,
  status: "issued",
  updatedAt: timestamp,
  version: 0,
};

function fakeDatabase() {
  const transactions: TransactionOperation[][] = [];
  const brainRecord = brainPlatformRecord(brain);
  const database: DynamoDatabaseService = {
    deleteRecord: async () => {},
    getRecord: async (_table, recordKey) =>
      recordKey.pk === brainRecord.pk && recordKey.sk === brainRecord.sk ? brainRecord : undefined,
    putRecord: async () => {},
    queryRecords: async () => ({ items: [] }),
    transactWrite: async (operations) => {
      transactions.push([...operations]);
      return;
    },
  };
  return { database, transactions };
}

function persistentDatabase(): DynamoDatabaseService {
  const records = new Map<string, PlatformRecord>();
  const brainRecord = brainPlatformRecord(brain);
  records.set(`${brainRecord.pk}|${brainRecord.sk}`, brainRecord);
  return {
    deleteRecord: async () => {},
    getRecord: async (_table, recordKey) => records.get(`${recordKey.pk}|${recordKey.sk}`),
    putRecord: async () => {},
    queryRecords: async () => ({ items: [] }),
    transactWrite: async (operations) => {
      for (const operation of operations) {
        if (operation.kind === "put") {
          records.set(`${operation.record.pk}|${operation.record.sk}`, operation.record);
        }
      }
    },
  };
}

const issueInput = {
  actor: { kind: "human", principalId },
  authorizingGrant: grant,
  eventId,
  source,
  ticket,
} as const;

function lease(status: BrainUploadLease["status"] = "active"): BrainUploadLease {
  return {
    brainId,
    createdAt: timestamp,
    expiresAt,
    id: leaseId,
    organizationId,
    owner: leaseId,
    status,
    ticketId,
    updatedAt: timestamp,
    version: status === "active" ? 0 : 1,
  };
}

function liveUploadStore() {
  const fake = fakeDynamoDocumentClient();
  for (const record of [
    withCanonicalRecordKeys({
      data: {
        createdAt: timestamp,
        id: organizationId,
        name: "Deployments.ai",
        slug: "deployments-ai",
        status: "active",
        updatedAt: timestamp,
        version: 1,
      },
      itemType: "organization" as const,
    }),
    {
      data: { kind: "human", status: "active" },
      itemType: "principal",
      pk: key("PRINCIPAL", principalId),
      sk: key("PRINCIPAL", principalId),
    },
    {
      data: { status: "active" },
      itemType: "organization-member",
      pk: key("ORG", organizationId),
      sk: key("ORGANIZATION-MEMBER", principalId),
    },
    brainPlatformRecord(brain),
    brainSourcePlatformRecord(source),
    brainGrantPlatformRecord(grant),
  ]) {
    fake.put("control", record);
  }
  let held = 0;
  let waiting: (() => void)[] = [];
  const client = {
    send: async (command: unknown, options?: unknown) => {
      if (command instanceof TransactWriteCommand && held > 0) {
        const { promise, resolve } = Promise.withResolvers<void>();
        waiting.push(resolve);
        if (waiting.length === held) {
          held = 0;
          for (const release of waiting) release();
          waiting = [];
        }
        await promise;
      }
      return fake.client.send(command as never, options as never);
    },
  } as unknown as typeof fake.client;
  return {
    counters: () =>
      Object.fromEntries(
        fake
          .items("usage")
          .filter((item) => item.itemType === "rate-limit-counter")
          .map((item) => {
            const data = item.data as { readonly count: number; readonly limitKey: string };
            return [data.limitKey, data.count];
          })
          .toSorted(([left], [right]) => String(left).localeCompare(String(right))),
      ),
    database: makeDynamoDatabase(client),
    holdNextTransactions: (count: number) => {
      held = count;
    },
  };
}

describe("Brain upload repository", () => {
  test("expires an unconsumed ticket into a durable cleanup job and releases reservations", async () => {
    const fake = fakeDatabase();
    const result = await expireBrainUploadTicket({
      bucket: "content-bucket",
      database: fake.database,
      eventId,
      now: "2026-07-30T12:11:00.000Z",
      ticket,
    });

    expect(result?.ticket.status).toBe("expired");
    expect(result?.cleanup.data).toMatchObject({
      bucket: "content-bucket",
      objectKey: ticket.objectKey,
      status: "pending",
      ticketId,
    });
    expect(
      fake.transactions[0]!.filter((operation) => operation.kind === "put").map(
        (operation) => operation.record.itemType,
      ),
    ).toEqual([
      "brain-upload-ticket",
      "brain-content-cleanup",
      "rate-limit-counter",
      "rate-limit-counter",
      "rate-limit-counter",
      "rate-limit-counter",
      "rate-limit-counter",
      "rate-limit-counter",
      "semantic-event",
    ]);
  });

  test("issues a ticket behind live Brain, source, caller, and grant fences", async () => {
    const fake = fakeDatabase();
    await makeBrainUploadRepository(fake.database).issueUploadTicket({
      actor: { kind: "human", principalId },
      authorizingGrant: grant,
      eventId,
      source,
      ticket,
    });

    expect(
      fake.transactions[0]!.filter((operation) => operation.kind === "condition-check").map(
        (operation) => operation.expressionAttributeValues?.[":itemType"],
      ),
    ).toEqual([
      "organization",
      undefined,
      "principal",
      "organization-member",
      "brain",
      "brain-source",
      "brain-grant",
    ]);
    expect(
      fake.transactions[0]!.some(
        (operation) =>
          operation.kind === "condition-check" &&
          operation.key.sk === `ERASURE-FENCE#${organizationId}` &&
          operation.conditionExpression.includes("attribute_not_exists"),
      ),
    ).toBe(true);
    expect(
      fake.transactions[0]!.filter((operation) => operation.kind === "put").map(
        (operation) => operation.record.itemType,
      ),
    ).toEqual([
      "brain-upload-ticket",
      "rate-limit-counter",
      "rate-limit-counter",
      "rate-limit-counter",
      "rate-limit-counter",
      "rate-limit-counter",
      "rate-limit-counter",
      "rate-limit-counter",
      "rate-limit-counter",
      "semantic-event",
    ]);
  });

  test("starts the stream by atomically advancing the ticket and creating its active lease", async () => {
    const fake = fakeDatabase();
    const streaming = { ...ticket, status: "streaming" as const, version: 1 };
    const result = await makeBrainUploadRepository(fake.database).beginUpload({
      actor: { kind: "human", principalId },
      authorizingGrant: grant,
      lease: lease(),
      next: streaming,
      previous: ticket,
      source,
    });

    expect(result.status).toBe("streaming");
    expect(
      fake.transactions[0]!.filter((operation) => operation.kind === "put").map(
        (operation) => operation.record.itemType,
      ),
    ).toEqual(["brain-upload-ticket", "brain-upload-lease"]);
  });

  test("refuses a caller's 61st ticket in one hour by default", async () => {
    const database = persistentDatabase();
    const repository = makeBrainUploadRepository(database);
    for (let issued = 0; issued < 60; issued += 1) {
      await repository.issueUploadTicket(issueInput);
      await expireBrainUploadTicket({
        bucket: "content-bucket",
        database,
        eventId,
        now: "2026-07-30T12:11:00.000Z",
        ticket,
      });
    }

    expect(repository.issueUploadTicket(issueInput)).rejects.toThrow(
      "Brain upload quota exceeded for brain-upload.issuance.caller.",
    );
  });

  test("refuses the ticket above an overridden hourly caller issuance quota", async () => {
    const repository = makeBrainUploadRepository(persistentDatabase(), {
      ...DEFAULT_BRAIN_UPLOAD_QUOTAS,
      hourlyIssuance: { caller: 3, organization: 500 },
    });
    for (let issued = 0; issued < 3; issued += 1) {
      expect((await repository.issueUploadTicket(issueInput)).status).toBe("issued");
    }

    expect(repository.issueUploadTicket(issueInput)).rejects.toThrow(
      "Brain upload quota exceeded for brain-upload.issuance.caller.",
    );
  });

  test("completes a reserved upload after its outstanding quota is lowered", async () => {
    const database = persistentDatabase();
    const issuing = makeBrainUploadRepository(database);
    for (let issued = 0; issued < 3; issued += 1) {
      await issuing.issueUploadTicket(issueInput);
    }
    const streaming = { ...ticket, status: "streaming" as const, version: 1 };
    const completed = await makeBrainUploadRepository(database, {
      ...DEFAULT_BRAIN_UPLOAD_QUOTAS,
      outstandingTickets: { brain: 1, caller: 1, organization: 1 },
    }).completeUpload({
      actor: { kind: "human", principalId },
      authorizingGrant: grant,
      lease: lease("completed"),
      next: {
        ...streaming,
        bodyRef: {
          bucket: "content-bucket",
          byteSize: ticket.expectedByteSize,
          contentType: ticket.mediaType,
          key: ticket.objectKey,
          sha256: ticket.expectedContentHash,
          versionId: "object-version",
        },
        completedAt: timestamp,
        status: "completed",
        version: 2,
      },
      previous: streaming,
      previousLease: lease(),
      source,
    });

    expect(completed.status).toBe("completed");
  });
});

describe("Brain upload quota counters under concurrency", () => {
  test("issues and completes two concurrent uploads in one Brain", async () => {
    const store = liveUploadStore();
    const repository = makeBrainUploadRepository(store.database);
    const tickets = ["01ARZ3NDEKTSV4RRFFQ69G5FC1", "01ARZ3NDEKTSV4RRFFQ69G5FC2"].map(
      (id): BrainUploadTicket => ({
        ...ticket,
        id,
        objectKey: `organizations/${organizationId}/brains/${brainId}/document-versions/${id}/original`,
      }),
    );
    const leases = tickets.map(
      (issued): BrainUploadLease => ({
        ...lease(),
        id: issued.id,
        owner: issued.id,
        ticketId: issued.id,
      }),
    );

    store.holdNextTransactions(2);
    await Promise.all(
      tickets.map((issued, index) =>
        repository.issueUploadTicket({
          ...issueInput,
          eventId: `01ARZ3NDEKTSV4RRFFQ69G5FD${index + 1}`,
          ticket: issued,
        }),
      ),
    );
    const streaming = await Promise.all(
      tickets.map((issued, index) =>
        repository.beginUpload({
          actor: issueInput.actor,
          authorizingGrant: grant,
          lease: leases[index]!,
          next: { ...issued, status: "streaming", version: 1 },
          previous: issued,
          source,
        }),
      ),
    );
    store.holdNextTransactions(2);
    const completed = await Promise.all(
      streaming.map((current, index) =>
        repository.completeUpload({
          actor: issueInput.actor,
          authorizingGrant: grant,
          lease: { ...leases[index]!, status: "completed", version: 1 },
          next: {
            ...current,
            bodyRef: {
              bucket: "content-bucket",
              byteSize: current.expectedByteSize,
              contentType: current.mediaType,
              key: current.objectKey,
              sha256: current.expectedContentHash,
              versionId: `object-version-${index + 1}`,
            },
            completedAt: timestamp,
            status: "completed",
            version: 2,
          },
          previous: current,
          previousLease: leases[index]!,
          source,
        }),
      ),
    );

    expect(completed.map(({ id, status }) => [id, status])).toEqual([
      ["01ARZ3NDEKTSV4RRFFQ69G5FC1", "completed"],
      ["01ARZ3NDEKTSV4RRFFQ69G5FC2", "completed"],
    ]);
    expect(store.counters()).toEqual({
      "brain-upload.issuance.caller": 2,
      "brain-upload.issuance.organization": 2,
      "brain-upload.outstanding-bytes.brain": 0,
      "brain-upload.outstanding-bytes.caller": 0,
      "brain-upload.outstanding-bytes.organization": 0,
      "brain-upload.outstanding-tickets.brain": 0,
      "brain-upload.outstanding-tickets.caller": 0,
      "brain-upload.outstanding-tickets.organization": 0,
    });
  });
});
