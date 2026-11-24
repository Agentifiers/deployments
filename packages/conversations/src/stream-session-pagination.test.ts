import { expect, test } from "bun:test";
import {
  MessageRecord,
  ThreadRecord,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import {
  createConversationStreamSession,
  readConversationHistory,
  transientConversationMessageMetadata,
} from "./index.ts";

const ids = Array.from(
  { length: 24 },
  (_, index) => `01ARZ3NDEKTSV4RRFFQ69G7F${String(index).padStart(2, "0")}`,
) as Ulid[];
const scope = {
  environmentId: ids[0]!,
  organizationId: ids[1]!,
  projectId: ids[2]!,
  threadId: ids[3]!,
};

function message(id: Ulid, sequence: number, transient = false) {
  return Schema.decodeUnknownSync(MessageRecord)(
    withCanonicalRecordKeys({
      data: {
        body: `Message ${sequence}`,
        contentHash: String(sequence).padStart(64, "0"),
        createdAt: "2026-07-24T12:00:00.000Z",
        id,
        ...(transient ? { metadata: transientConversationMessageMetadata() } : {}),
        ...scope,
        role: sequence % 2 === 0 ? ("user" as const) : ("assistant" as const),
        sequence,
      },
      itemType: "message" as const,
    }),
  ) as Extract<PlatformRecord, { readonly itemType: "message" }>;
}

function thread(version: number) {
  return Schema.decodeUnknownSync(ThreadRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: ids[21]!,
        archived: false,
        channel: "api",
        createdAt: "2026-07-24T12:00:00.000Z",
        createdBy: { type: "system" as const },
        id: scope.threadId,
        pinned: false,
        streamId: ids[22]!,
        title: "History snapshot",
        updatedAt: "2026-07-24T12:00:00.000Z",
        version,
        ...scope,
      },
      itemType: "thread" as const,
    }),
  );
}

test("history reads scan past transient automation inputs", async () => {
  const transient = message(ids[4]!, 0, true);
  const visible = message(ids[5]!, 1);
  const currentThread = thread(1);
  let queries = 0;
  const database = {
    getRecord: async (_table: string, key: { readonly sk: string }) =>
      key.sk.startsWith("THREAD#") ? currentThread : undefined,
    queryRecords: async () => {
      queries += 1;
      return queries === 1
        ? {
            items: [transient],
            lastEvaluatedKey: { pk: transient.pk, sk: transient.sk },
          }
        : { items: [visible] };
    },
  } as unknown as DynamoDatabaseService;

  const history = await readConversationHistory(database, scope, { limit: 1 });

  expect(history.items.map((item) => item.data.id)).toEqual([visible.data.id]);
  expect(queries).toBe(2);
});

test("stream sessions seed one history page and use the snapshot sequence boundary", async () => {
  const messages = Array.from({ length: 16 }, (_, index) => message(ids[index + 4]!, index));
  const currentThread = thread(15);
  const queries: Array<Readonly<Record<string, unknown>>> = [];
  const database = {
    getRecord: async (_table: string, key: { readonly sk: string }) =>
      key.sk.startsWith("THREAD#") ? currentThread : undefined,
    queryRecords: async (_table: string, input: Readonly<Record<string, unknown>>) => {
      queries.push(input);
      if (input.ScanIndexForward === false) return { items: [messages.at(-1)!] };
      return {
        items: messages.slice(0, 15),
        lastEvaluatedKey: { pk: messages[14]!.pk, sk: messages[14]!.sk },
      };
    },
  } as unknown as DynamoDatabaseService;

  const result = await createConversationStreamSession({
    claims: {
      ...scope,
      expiresAt: "2099-01-01T00:00:00.000Z",
      permissions: ["read"],
      sessionId: ids[20]!,
    },
    createReadUrl: (offset) => `https://streams.example.test/read?offset=${offset}`,
    database,
    scope,
    transport: {
      append: async () => ({}),
      currentOffset: async () => "42",
    },
  });

  expect(queries).toHaveLength(1);
  expect(result.history.items).toHaveLength(15);
  expect(result.history.nextCursor).toBeDefined();
  expect(result.session.replayState.canonicalMessageIds).toHaveLength(15);
  expect(result.session.replayState.historyThroughSequence).toBe(15);
});
