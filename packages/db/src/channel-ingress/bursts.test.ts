import { describe, expect, test } from "bun:test";

import type { DynamoValue } from "../record-schema.ts";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import type { PlatformRecord } from "../records/index.ts";
import type { Ulid } from "../ids.ts";
import {
  makeChannelIngressBurstPersistence,
  type ChannelIngressBurstMessageInput,
} from "./bursts.ts";

const id = (suffix: string) => `01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}` as Ulid;

interface MemoryDatabase extends DynamoDatabaseService {
  readonly deleteRecords: (predicate: (record: PlatformRecord) => boolean) => void;
}

function memoryDatabase(): MemoryDatabase {
  const records = new Map<string, PlatformRecord>();
  const storageKey = (record: Pick<PlatformRecord, "pk" | "sk">) =>
    `${record.pk}\u0000${record.sk}`;

  function conflict(): never {
    const error = new Error("Conditional write conflict.");
    error.name = "ConditionalCheckFailedException";
    throw error;
  }

  function check(operation: TransactionOperation) {
    if (operation.kind !== "put") throw new Error("The test store only supports puts.");
    const current = records.get(storageKey(operation.record));
    if (!operation.previousRecord) {
      if (current && !operation.allowExisting) conflict();
      return;
    }
    const currentVersion = (current?.data as { readonly version?: unknown } | undefined)?.version;
    const previousVersion = (operation.previousRecord.data as { readonly version?: unknown })
      .version;
    if (
      !current ||
      current.itemType !== operation.previousRecord.itemType ||
      currentVersion !== previousVersion
    ) {
      conflict();
    }
  }

  return {
    deleteRecords: (predicate) => {
      for (const [key, record] of records) {
        if (predicate(record)) records.delete(key);
      }
    },
    deleteRecord: () => Promise.reject("not implemented"),
    getRecord: (_table, key) =>
      (async () => {
        const value = records.get(`${key.pk}\u0000${key.sk}`);
        return value ? value : undefined;
      })(),
    putRecord: () => Promise.reject("not implemented"),
    queryRecords: () => Promise.reject("not implemented"),
    transactWrite: (operations) =>
      (async () => {
        operations.forEach(check);
        for (const operation of operations) {
          if (operation.kind === "put") {
            records.set(storageKey(operation.record), operation.record);
          }
        }
      })(),
  };
}

const scope = {
  bindingId: id("1"),
  environmentId: id("2"),
  organizationId: id("3"),
  projectId: id("4"),
};

function input(args: {
  readonly channel: "imessage" | "rcs" | "slack" | "sms" | "telegram";
  readonly content: string;
  readonly externalMessageId: string;
  readonly provider:
    | "aws_end_user_messaging_rcs"
    | "slack_cloudflare_edge"
    | "slack_edge"
    | "telegram";
  readonly receivedAt: string;
  readonly senderId?: string;
}): ChannelIngressBurstMessageInput {
  const payload = {
    ingress: {
      channel: args.channel,
      content: args.content,
      externalChannelId: "channel-1",
      externalMessageId: args.externalMessageId,
      externalThreadKey: "thread-1",
      ...(args.channel === "slack" ? { externalWorkspaceId: "workspace-1" } : {}),
      provider: args.provider,
      sender: { id: args.senderId ?? "sender-1" },
    },
    receivedAt: args.receivedAt,
  } satisfies DynamoValue;
  return {
    ...scope,
    contentBytes: new TextEncoder().encode(args.content).byteLength,
    payload,
    receivedAt: args.receivedAt,
    route: {
      bindingId: scope.bindingId,
      channel: args.channel,
      externalChannelId: "channel-1",
      externalThreadKey: "thread-1",
      ...(args.channel === "slack" ? { externalWorkspaceId: "workspace-1" } : {}),
      provider: args.provider,
    },
    senderId: args.senderId ?? "sender-1",
    sourceFingerprint: `fingerprint-${args.externalMessageId}`,
    sourceMessageId: args.externalMessageId,
  };
}

describe("channel ingress burst persistence", () => {
  test("rejects a message limit that cannot fit a rollover transaction", () => {
    expect(() =>
      makeChannelIngressBurstPersistence({
        database: memoryDatabase(),
        maxMessages: 46,
      }),
    ).toThrow("cannot exceed 45");
  });

  test("preserves the existing singleton content limit", async () => {
    const persistence = makeChannelIngressBurstPersistence({
      database: memoryDatabase(),
      now: () => new Date("2026-08-26T18:00:00.000Z"),
    });
    const large = input({
      channel: "telegram",
      content: "x".repeat(245 * 1_024),
      externalMessageId: "message-large",
      provider: "telegram",
      receivedAt: "2026-08-26T18:00:00.000Z",
    });

    expect(persistence.stage(large)).resolves.toMatchObject({ duplicate: false });
  });

  test("preserves the existing singleton metadata limit", async () => {
    const persistence = makeChannelIngressBurstPersistence({
      database: memoryDatabase(),
      now: () => new Date("2026-08-26T18:00:00.000Z"),
    });
    const large = {
      ...input({
        channel: "telegram",
        content: "a neutral note",
        externalMessageId: "message-large-metadata",
        provider: "telegram",
        receivedAt: "2026-08-26T18:00:00.000Z",
      }),
      metadataBytes: 63 * 1_024,
    };

    expect(persistence.stage(large)).resolves.toMatchObject({ duplicate: false });
  });

  for (const provider of [
    { channel: "telegram", label: "Telegram", provider: "telegram" },
    { channel: "slack", label: "Slack edge", provider: "slack_edge" },
    {
      channel: "slack",
      label: "Slack Cloudflare edge",
      provider: "slack_cloudflare_edge",
    },
    { channel: "rcs", label: "AWS RCS", provider: "aws_end_user_messaging_rcs" },
  ] as const) {
    test(`preserves every ordered ${provider.label} bubble in one durable burst`, async () => {
      let now = Date.parse("2026-08-26T18:00:00.000Z");
      const persistence = makeChannelIngressBurstPersistence({
        database: memoryDatabase(),
        now: () => new Date(now),
        quietPeriodMs: 1_500,
      });
      const messages = [
        input({
          ...provider,
          content: "first note",
          externalMessageId: "message-1",
          receivedAt: "2026-08-26T18:00:00.000Z",
        }),
        input({
          ...provider,
          content: "second note",
          externalMessageId: "message-2",
          receivedAt: "2026-08-26T18:00:00.250Z",
        }),
        input({
          ...provider,
          content: "final note",
          externalMessageId: "message-3",
          receivedAt: "2026-08-26T18:00:00.500Z",
        }),
      ];

      const staged = [];
      for (const message of messages) {
        now = Date.parse(message.receivedAt);
        staged.push(await persistence.stage(message));
      }
      const flush = staged[0]!.flushes[0]!;
      expect(staged.map(({ flushes }) => flushes.at(-1)?.dueAt)).toEqual([
        "2026-08-26T18:00:01.500Z",
        "2026-08-26T18:00:01.750Z",
        "2026-08-26T18:00:02.000Z",
      ]);

      now = Date.parse("2026-08-26T18:00:01.999Z");
      expect(persistence.prepare(flush)).resolves.toEqual({
        dueAt: "2026-08-26T18:00:02.000Z",
        kind: "waiting",
        waitFor: "quiet-window",
      });

      now = Date.parse("2026-08-26T18:00:02.000Z");
      const prepared = await persistence.prepare(flush);
      expect(prepared).toMatchObject({
        kind: "ready",
        sourceMessageIds: ["message-1", "message-2", "message-3"],
      });
      if (prepared.kind !== "ready") throw new Error("Expected a prepared burst.");
      expect(
        prepared.payloads.map(
          (payload) =>
            (payload as { readonly ingress: { readonly content: string } }).ingress.content,
        ),
      ).toEqual(["first note", "second note", "final note"]);

      expect(persistence.prepare(flush)).resolves.toEqual(prepared);
      now += 60_000;
      expect(persistence.stage(messages[1]!)).resolves.toMatchObject({
        burstId: prepared.burstId,
      });
    });
  }

  test("preserves FIFO acceptance order when webhook timestamps arrive out of order", async () => {
    let now = Date.parse("2026-08-26T18:00:00.500Z");
    const persistence = makeChannelIngressBurstPersistence({
      database: memoryDatabase(),
      now: () => new Date(now),
      quietPeriodMs: 1_500,
    });
    const acceptedFirst = input({
      channel: "telegram",
      content: "accepted first",
      externalMessageId: "message-2",
      provider: "telegram",
      receivedAt: "2026-08-26T18:00:00.250Z",
    });
    const acceptedSecond = input({
      channel: "telegram",
      content: "accepted second",
      externalMessageId: "message-1",
      provider: "telegram",
      receivedAt: "2026-08-26T18:00:00.000Z",
    });

    const firstStage = await persistence.stage(acceptedFirst);
    now += 10;
    await persistence.stage(acceptedSecond);
    now = Date.parse("2026-08-26T18:00:02.010Z");

    expect(persistence.prepare(firstStage.flushes[0]!)).resolves.toMatchObject({
      kind: "ready",
      sourceMessageIds: ["message-2", "message-1"],
    });
  });

  test("seals interleaved senders into ordered conversation bursts", async () => {
    let now = Date.parse("2026-08-26T18:00:00.000Z");
    const persistence = makeChannelIngressBurstPersistence({
      database: memoryDatabase(),
      now: () => new Date(now),
      quietPeriodMs: 1_500,
    });
    const first = await persistence.stage(
      input({
        channel: "slack",
        content: "first sender",
        externalMessageId: "message-1",
        provider: "slack_edge",
        receivedAt: "2026-08-26T18:00:00.000Z",
        senderId: "sender-1",
      }),
    );
    now += 100;
    const second = await persistence.stage(
      input({
        channel: "slack",
        content: "second sender",
        externalMessageId: "message-2",
        provider: "slack_edge",
        receivedAt: "2026-08-26T18:00:00.100Z",
        senderId: "sender-2",
      }),
    );
    now += 100;
    const third = await persistence.stage(
      input({
        channel: "slack",
        content: "first sender again",
        externalMessageId: "message-3",
        provider: "slack_edge",
        receivedAt: "2026-08-26T18:00:00.200Z",
        senderId: "sender-1",
      }),
    );

    expect([second.routeId, third.routeId]).toEqual([first.routeId, first.routeId]);
    expect(new Set([first.burstId, second.burstId, third.burstId]).size).toBe(3);
    expect(second.flushes[0]?.burstId).toBe(first.burstId);
    expect(third.flushes[0]?.burstId).toBe(second.burstId);
    expect(persistence.prepare(first.flushes[0]!)).resolves.toMatchObject({
      kind: "ready",
      sourceMessageIds: ["message-1"],
    });
    expect(persistence.prepare(third.flushes[0]!)).resolves.toMatchObject({
      kind: "waiting",
    });
    await persistence.complete(first.flushes[0]!);
    expect(persistence.prepare(third.flushes[0]!)).resolves.toMatchObject({
      kind: "ready",
      sourceMessageIds: ["message-2"],
    });
    await persistence.complete(third.flushes[0]!);
    now = Date.parse("2026-08-26T18:00:01.700Z");
    expect(persistence.prepare(third.flushes.at(-1)!)).resolves.toMatchObject({
      kind: "ready",
      sourceMessageIds: ["message-3"],
    });
  });

  test("seals an elapsed quiet window before accepting the next source", async () => {
    let now = Date.parse("2026-08-26T18:00:00.000Z");
    const persistence = makeChannelIngressBurstPersistence({
      database: memoryDatabase(),
      now: () => new Date(now),
      quietPeriodMs: 1_500,
    });
    const first = input({
      channel: "telegram",
      content: "first turn",
      externalMessageId: "message-1",
      provider: "telegram",
      receivedAt: "2026-08-26T18:00:00.000Z",
    });
    const second = input({
      channel: "telegram",
      content: "second turn",
      externalMessageId: "message-2",
      provider: "telegram",
      receivedAt: "2026-08-26T18:00:01.750Z",
    });

    const firstStage = await persistence.stage(first);
    now = Date.parse(second.receivedAt);
    const secondStage = await persistence.stage(second);

    expect(secondStage.flushes).toHaveLength(2);
    expect(secondStage.flushes[0]?.burstId).toBe(firstStage.burstId);
    expect(secondStage.burstId).not.toBe(firstStage.burstId);
    expect(persistence.prepare(firstStage.flushes[0]!)).resolves.toMatchObject({
      kind: "ready",
      sourceMessageIds: ["message-1"],
    });
    expect(persistence.prepare(secondStage.flushes[1]!)).resolves.toMatchObject({
      dueAt: "2026-08-26T18:00:03.250Z",
      kind: "waiting",
    });
  });

  test("uses receipt time to separate messages after a consumer backlog", async () => {
    let now = Date.parse("2026-08-26T18:10:00.000Z");
    const persistence = makeChannelIngressBurstPersistence({
      database: memoryDatabase(),
      now: () => new Date(now),
      quietPeriodMs: 1_500,
    });
    const firstStage = await persistence.stage(
      input({
        channel: "telegram",
        content: "earlier turn",
        externalMessageId: "message-1",
        provider: "telegram",
        receivedAt: "2026-08-26T18:00:00.000Z",
      }),
    );
    now += 10;
    const secondStage = await persistence.stage(
      input({
        channel: "telegram",
        content: "later turn",
        externalMessageId: "message-2",
        provider: "telegram",
        receivedAt: "2026-08-26T18:05:00.000Z",
      }),
    );

    expect(firstStage.flushes[0]?.dueAt).toBe("2026-08-26T18:10:01.500Z");
    expect(secondStage.flushes).toHaveLength(2);
    expect(secondStage.burstId).not.toBe(firstStage.burstId);
  });

  test("holds a backlogged rapid burst open from durable acceptance", async () => {
    let now = Date.parse("2026-08-26T18:10:00.000Z");
    const persistence = makeChannelIngressBurstPersistence({
      database: memoryDatabase(),
      now: () => new Date(now),
      quietPeriodMs: 1_500,
    });
    const first = await persistence.stage(
      input({
        channel: "telegram",
        content: "first queued note",
        externalMessageId: "message-1",
        provider: "telegram",
        receivedAt: "2026-08-26T18:00:00.000Z",
      }),
    );
    now += 10;
    const second = await persistence.stage(
      input({
        channel: "telegram",
        content: "second queued note",
        externalMessageId: "message-2",
        provider: "telegram",
        receivedAt: "2026-08-26T18:00:00.250Z",
      }),
    );

    expect(second.burstId).toBe(first.burstId);
    expect(second.flushes[0]?.dueAt).toBe("2026-08-26T18:10:01.510Z");
    now += 1_490;
    expect(persistence.prepare(first.flushes[0]!)).resolves.toMatchObject({
      dueAt: "2026-08-26T18:10:01.510Z",
      kind: "waiting",
      waitFor: "quiet-window",
    });
    now += 10;
    expect(persistence.prepare(first.flushes[0]!)).resolves.toMatchObject({
      kind: "ready",
      sourceMessageIds: ["message-1", "message-2"],
    });
  });

  test("clamps a future receipt time to the consumer clock", async () => {
    const persistence = makeChannelIngressBurstPersistence({
      database: memoryDatabase(),
      now: () => new Date("2026-08-26T18:00:00.000Z"),
      quietPeriodMs: 1_500,
    });

    const staged = await persistence.stage(
      input({
        channel: "telegram",
        content: "clock-skewed note",
        externalMessageId: "message-future",
        provider: "telegram",
        receivedAt: "2026-08-26T18:05:00.000Z",
      }),
    );

    expect(staged.flushes[0]?.dueAt).toBe("2026-08-26T18:00:01.500Z");
  });

  test("retains an accepted burst through the full queue and DLQ redrive horizon", async () => {
    let now = Date.parse("2026-08-01T18:00:00.000Z");
    const persistence = makeChannelIngressBurstPersistence({
      database: memoryDatabase(),
      now: () => new Date(now),
      quietPeriodMs: 1_500,
    });
    const staged = await persistence.stage(
      input({
        channel: "telegram",
        content: "delayed recovery note",
        externalMessageId: "message-late-redrive",
        provider: "telegram",
        receivedAt: "2026-08-01T18:00:00.000Z",
      }),
    );

    now = Date.parse("2026-08-19T18:00:00.001Z");

    expect(persistence.prepare(staged.flushes[0]!)).resolves.toMatchObject({
      kind: "ready",
      sourceMessageIds: ["message-late-redrive"],
    });
  });

  test("atomically replaces a head whose pending sources reached retention", async () => {
    let now = Date.parse("2026-08-01T18:00:00.000Z");
    const persistence = makeChannelIngressBurstPersistence({
      database: memoryDatabase(),
      now: () => new Date(now),
      quietPeriodMs: 1_500,
    });
    const expired = input({
      channel: "telegram",
      content: "old pending note",
      externalMessageId: "message-old",
      provider: "telegram",
      receivedAt: "2026-08-01T18:00:00.000Z",
    });
    const current = input({
      channel: "telegram",
      content: "current note",
      externalMessageId: "message-current",
      provider: "telegram",
      receivedAt: "2026-08-31T18:00:00.001Z",
    });

    const expiredStage = await persistence.stage(expired);
    now = Date.parse(current.receivedAt);
    const currentStage = await persistence.stage(current);

    expect(currentStage.burstId).not.toBe(expiredStage.burstId);
    expect(currentStage.flushes).toHaveLength(1);
    now += 1_500;
    expect(persistence.prepare(currentStage.flushes[0]!)).resolves.toMatchObject({
      kind: "ready",
      sourceMessageIds: ["message-current"],
    });
  });

  test("permanently accounts for each source independently of later burst regrouping", async () => {
    let now = Date.parse("2026-08-01T18:00:00.000Z");
    const database = memoryDatabase();
    const persistence = makeChannelIngressBurstPersistence({
      database,
      now: () => new Date(now),
      quietPeriodMs: 1_500,
    });
    const first = input({
      channel: "telegram",
      content: "first note",
      externalMessageId: "message-1",
      provider: "telegram",
      receivedAt: "2026-08-01T18:00:00.000Z",
    });
    const second = input({
      channel: "telegram",
      content: "second note",
      externalMessageId: "message-2",
      provider: "telegram",
      receivedAt: "2026-08-01T18:00:00.250Z",
    });
    const firstStage = await persistence.stage(first);
    now += 250;
    await persistence.stage(second);
    now += 1_500;
    expect(persistence.prepare(firstStage.flushes[0]!)).resolves.toMatchObject({
      kind: "ready",
      sourceMessageIds: ["message-1", "message-2"],
    });
    await persistence.complete(firstStage.flushes[0]!);

    now = Date.parse("2026-08-31T18:00:00.001Z");
    database.deleteRecords(
      (record) =>
        record.itemType === "channel-ingress-source" || record.itemType === "channel-ingress-burst",
    );
    const replayStage = await persistence.stage({
      ...first,
      receivedAt: new Date(now).toISOString(),
    });

    expect(replayStage).toEqual({
      burstId: firstStage.burstId,
      duplicate: true,
      flushes: [],
      routeId: firstStage.routeId,
    });
  });

  test("suppresses a logically expired source before Dynamo TTL deletes it", async () => {
    let now = Date.parse("2026-08-01T18:00:00.000Z");
    const persistence = makeChannelIngressBurstPersistence({
      database: memoryDatabase(),
      now: () => new Date(now),
      quietPeriodMs: 1_500,
    });
    const original = input({
      channel: "telegram",
      content: "old note",
      externalMessageId: "message-reused",
      provider: "telegram",
      receivedAt: "2026-08-01T18:00:00.000Z",
    });
    const originalStage = await persistence.stage(original);
    now = Date.parse("2026-08-31T18:00:00.001Z");

    const replayStage = await persistence.stage({
      ...original,
      payload: {
        ...(original.payload as Record<string, DynamoValue>),
        receivedAt: new Date(now).toISOString(),
      },
      receivedAt: new Date(now).toISOString(),
    });

    expect(replayStage).toEqual({
      burstId: originalStage.burstId,
      duplicate: true,
      flushes: [],
      routeId: originalStage.routeId,
    });

    expect(
      persistence.stage({ ...original, sourceFingerprint: "fingerprint-replacement" }),
    ).rejects.toThrow("source message ID was reused");
  });

  test("seals a bounded burst during staging without reusing its ID", async () => {
    let now = Date.parse("2026-08-26T18:00:00.500Z");
    const persistence = makeChannelIngressBurstPersistence({
      database: memoryDatabase(),
      maxMessages: 2,
      now: () => new Date(now),
      quietPeriodMs: 1_500,
    });
    const laterSeed = input({
      channel: "slack",
      content: "arrived first",
      externalMessageId: "message-3",
      provider: "slack_edge",
      receivedAt: "2026-08-26T18:00:00.300Z",
    });
    const earlier = input({
      channel: "slack",
      content: "arrived second",
      externalMessageId: "message-1",
      provider: "slack_edge",
      receivedAt: "2026-08-26T18:00:00.100Z",
    });
    const rollover = input({
      channel: "slack",
      content: "new bounded burst",
      externalMessageId: "message-2",
      provider: "slack_edge",
      receivedAt: "2026-08-26T18:00:00.200Z",
    });

    const firstStage = await persistence.stage(laterSeed);
    now += 10;
    await persistence.stage(earlier);
    now += 10;
    const rolloverStage = await persistence.stage(rollover);

    expect(rolloverStage.flushes).toHaveLength(2);
    expect(rolloverStage.flushes[0]?.burstId).toBe(firstStage.burstId);
    expect(rolloverStage.burstId).not.toBe(firstStage.burstId);
    expect(persistence.prepare(firstStage.flushes[0]!)).resolves.toMatchObject({
      kind: "ready",
      sourceMessageIds: ["message-3", "message-1"],
    });
    expect(persistence.stage(rollover)).resolves.toMatchObject({
      burstId: rolloverStage.burstId,
      duplicate: true,
      flushes: [
        expect.objectContaining({ burstId: firstStage.burstId }),
        expect.objectContaining({ burstId: rolloverStage.burstId }),
      ],
    });
  });
});
