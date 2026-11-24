import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import { ChannelIngressBurstHeadRecord } from "../records/conversations.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { makeChannelIngressDispatchPersistence } from "./dispatch.ts";

const scope = {
  bindingId: "01ARZ3NDEKTSV4RRFFQ69G5FA1" as never,
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FA2" as never,
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FA3" as never,
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FA4" as never,
  routeId: "a".repeat(64),
  throughSequence: 2,
};

function head(nextSequence: number) {
  return Schema.decodeUnknownSync(ChannelIngressBurstHeadRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: "2026-09-03T00:00:00.000Z",
        environmentId: scope.environmentId,
        id: scope.routeId,
        nextSequence,
        organizationId: scope.organizationId,
        pending: [],
        projectId: scope.projectId,
        route: { bindingId: scope.bindingId },
        routeId: scope.routeId,
        updatedAt: "2026-09-03T00:00:00.000Z",
        version: nextSequence,
      },
      itemType: "channel-ingress-burst-head" as const,
    }),
  );
}

function database(record: ReturnType<typeof head>): DynamoDatabaseService {
  return {
    deleteRecord: () => Promise.resolve(),
    getRecord: () => Promise.resolve(record),
    putRecord: () => Promise.resolve(),
    queryRecords: () => Promise.resolve({ items: [] }),
    transactWrite: () => Promise.resolve(),
  };
}

describe("channel ingress dispatch fence", () => {
  test("returns a transactional fence at the prepared burst boundary", async () => {
    const result = await makeChannelIngressDispatchPersistence(database(head(3))).assess(scope);

    expect(result).toMatchObject({
      condition: {
        expressionAttributeValues: {
          ":bindingId": scope.bindingId,
          ":nextSequence": 3,
          ":routeId": scope.routeId,
          ":version": 3,
        },
        kind: "condition-check",
        table: "execution",
      },
      kind: "current",
    });
  });

  test("reports supersession when a newer source advanced the route head", async () => {
    expect(makeChannelIngressDispatchPersistence(database(head(4))).assess(scope)).resolves.toEqual(
      { kind: "superseded" },
    );
  });
});
