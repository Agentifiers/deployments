import { describe, expect, test } from "bun:test";
import {
  MessageRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { streamSessionForReturnedHistory } from "./stream-session-history.ts";

const ids = Array.from(
  { length: 8 },
  (_, index) => `01ARZ3NDEKTSV4RRFFQ69G5F${String(index).padStart(2, "0")}`,
) as Ulid[];

function message(id: Ulid, role: "assistant" | "user", sequence: number) {
  return Schema.decodeUnknownSync(MessageRecord)(
    withCanonicalRecordKeys({
      data: {
        body: role,
        contentHash: "a".repeat(64),
        createdAt: "2026-07-23T12:00:00.000Z",
        environmentId: ids[0]!,
        id,
        organizationId: ids[1]!,
        projectId: ids[2]!,
        role,
        sequence,
        threadId: ids[3]!,
      },
      itemType: "message" as const,
    }),
  ) as Extract<PlatformRecord, { readonly itemType: "message" }>;
}

describe("runtime stream session history", () => {
  test("preserves finalized replay seeds beyond the returned public history page", () => {
    const first = message(ids[4]!, "user", 0);
    const second = message(ids[5]!, "assistant", 1);
    const omitted = message(ids[6]!, "assistant", 2);

    const session = streamSessionForReturnedHistory(
      {
        environmentId: ids[0]!,
        expiresAt: "2026-07-23T12:05:00.000Z",
        offset: "10",
        organizationId: ids[1]!,
        permissions: ["read"],
        projectId: ids[2]!,
        readUrl: "https://api.example.test/stream?offset=10",
        replayState: {
          canonicalMessageIds: [first.data.id, second.data.id, omitted.data.id],
          finalizedMessageIds: [second.data.id, omitted.data.id],
          historyThroughSequence: 2,
        },
        sessionId: ids[7]!,
        threadId: ids[3]!,
      },
      [first, second],
    );

    expect(session.replayState).toEqual({
      canonicalMessageIds: [first.data.id, second.data.id],
      finalizedMessageIds: [second.data.id, omitted.data.id],
      historyThroughSequence: 2,
    });
  });
});
