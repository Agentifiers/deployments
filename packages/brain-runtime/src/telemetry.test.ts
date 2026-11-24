import { describe, expect, test } from "bun:test";
import {
  makeDynamoDatabase,
  MeterEventRecord,
  prepareDynamoTransactionOperations,
  withCanonicalRecordKeys,
  type TransactionOperation,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { Schema } from "effect";
import {
  makeBrainQueryRuntime,
  type Brain,
  type BrainRepository,
  type BrainSearchProviderClient,
} from "@deployments-ai/brains";
import { makeDynamoBrainQueryTelemetry } from "./telemetry.ts";

const ids = [
  "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  "01ARZ3NDEKTSV4RRFFQ69G5FB0",
  "01ARZ3NDEKTSV4RRFFQ69G5FB1",
  "01ARZ3NDEKTSV4RRFFQ69G5FB2",
  "01ARZ3NDEKTSV4RRFFQ69G5FB3",
  "01ARZ3NDEKTSV4RRFFQ69G5FB4",
  "01ARZ3NDEKTSV4RRFFQ69G5FB5",
  "01ARZ3NDEKTSV4RRFFQ69G5FB6",
  "01ARZ3NDEKTSV4RRFFQ69G5FB7",
] as const;

describe("Brain query telemetry", () => {
  test("persists identifier-only retrieval quality and an idempotent scoped meter", async () => {
    const transactions: TransactionOperation[][] = [];
    const generated = [ids[9], ids[10], ids[11]];
    const telemetry = makeDynamoBrainQueryTelemetry({
      database: {
        deleteRecord: async () => {},
        getRecord: async () => undefined,
        putRecord: async () => {},
        queryRecords: async () => ({ items: [] }),
        transactWrite: async (operations) => {
          transactions.push([...operations]);
        },
      },
      generateId: async () => generated.shift()!,
      now: () => new Date("2026-07-30T12:00:00.000Z"),
    });
    const attempt = await telemetry.record({
      authorizedBrainIds: [ids[1]],
      candidateCount: 4,
      canonicalDropCount: 3,
      context: {
        environmentId: ids[7],
        projectId: ids[6],
        purpose: "agent.brain.search",
        runId: ids[8],
        threadId: ids[12],
        workspaceId: undefined,
      },
      emittedCount: 1,
      latencyMs: 12,
      organizationId: ids[0],
      placementGeneration: 2,
      purpose: "search",
      query: "secret acquisition plan",
      results: [
        {
          citation: {
            brainId: ids[1],
            chunkId: "chunk-1",
            coordinates: { end: 12, kind: "unicode-scalar", start: 0 },
            documentId: ids[3],
            documentVersionId: ids[4],
            renditionId: ids[5],
            sourceId: ids[2],
          },
          excerpt: "sensitive excerpt",
          score: 0.9,
          sensitivity: "internal",
        },
      ],
      target: {
        location: {},
        providerId: "aws-native",
        schemaGeneration: 1,
        targetId: ids[8],
      },
    });

    const puts = transactions[0]!.filter((operation) => operation.kind === "put");
    expect(puts.map((operation) => operation.record.itemType)).toEqual([
      "brain-query-attempt",
      "brain-retrieval",
      "meter-event",
    ]);
    expect(attempt).toEqual({ queryAttemptId: ids[9] });
    expect(puts[0]?.kind === "put" ? puts[0].record.data : undefined).toMatchObject({
      id: ids[9],
      runId: ids[8],
      threadId: ids[12],
    });
    expect(puts[1]?.kind === "put" ? puts[1].record.data : undefined).toMatchObject({
      runId: ids[8],
      threadId: ids[12],
    });
    expect(JSON.stringify(puts)).not.toContain("secret acquisition plan");
    expect(JSON.stringify(puts)).not.toContain("sensitive excerpt");
    expect(puts[2]?.kind === "put" ? puts[2].record : undefined).toMatchObject({
      data: {
        idempotencyKey: `brain-query:${ids[9]}`,
        metric: "brain.retrieval",
        quantity: 1,
      },
    });
  });

  test("persists telemetry for the contract maximum of 50 hits within DynamoDB transaction limits", async () => {
    const committed: TransactionOperation[][] = [];
    const ulid = (n: number) => `01ARZ3NDEKTSV4RRFFQ69G${String(n).padStart(4, "0")}`;
    let next = 100;
    const telemetry = makeDynamoBrainQueryTelemetry({
      database: {
        deleteRecord: async () => {},
        getRecord: async () => undefined,
        putRecord: async () => {},
        queryRecords: async () => ({ items: [] }),
        transactWrite: async (operations) => {
          await prepareDynamoTransactionOperations(operations);
          committed.push([...operations]);
        },
      },
      generateId: async () => ulid(next++),
      now: () => new Date("2026-07-30T12:00:00.000Z"),
    });

    const attempt = await telemetry.record({
      authorizedBrainIds: [ulid(1)],
      candidateCount: 50,
      canonicalDropCount: 0,
      context: {
        environmentId: ulid(7),
        projectId: ulid(6),
        purpose: "brain-api",
        workspaceId: undefined,
      },
      emittedCount: 50,
      latencyMs: 40,
      organizationId: ulid(0),
      placementGeneration: 1,
      purpose: "search",
      query: "quarterly plan",
      results: Array.from({ length: 50 }, (_, rank) => ({
        citation: {
          brainId: ulid(1),
          chunkId: `chunk-${rank}`,
          coordinates: { end: 12, kind: "unicode-scalar" as const, start: 0 },
          documentId: ulid(3),
          documentVersionId: ulid(4),
          renditionId: ulid(5),
          sourceId: ulid(2),
        },
        excerpt: "excerpt",
        score: 1 - rank / 100,
        sensitivity: "internal" as const,
      })),
      target: { location: {}, providerId: "aws-native", schemaGeneration: 1, targetId: ulid(8) },
    });

    const itemTypes = committed.map((operations) =>
      operations.flatMap((operation) =>
        operation.kind === "put" ? [operation.record.itemType] : [],
      ),
    );
    const retrievals = committed
      .flat()
      .flatMap((operation) =>
        operation.kind === "put" && operation.record.itemType === "brain-retrieval"
          ? [operation.record.data]
          : [],
      );
    expect(attempt).toEqual({ queryAttemptId: ulid(100) });
    expect(itemTypes.flat().filter((type) => type === "brain-query-attempt")).toHaveLength(1);
    expect(itemTypes.at(-1)![0]).toBe("brain-query-attempt");
    expect(itemTypes.at(-1)!.at(-1)).toBe("meter-event");
    expect(retrievals.map((retrieval) => retrieval.rank)).toEqual(
      Array.from({ length: 50 }, (_, rank) => rank),
    );
    expect(retrievals.map((retrieval) => String(retrieval.queryAttemptId))).toEqual(
      Array.from({ length: 50 }, () => ulid(100)),
    );
  });

  describe("on a real DynamoDB database", () => {
    const ulid = (n: number) => `01ARZ3NDEKTSV4RRFFQ69G${String(n).padStart(4, "0")}`;
    const organizationId = ulid(0);

    function storedTelemetry() {
      const dynamo = fakeDynamoDocumentClient();
      dynamo.put(
        "control",
        withCanonicalRecordKeys({
          data: {
            createdAt: "2026-07-30T12:00:00.000Z",
            id: organizationId,
            name: "Brain Telemetry",
            slug: "brain-telemetry",
            status: "active",
            updatedAt: "2026-07-30T12:00:00.000Z",
            version: 1,
          },
          itemType: "organization",
        }),
      );
      let next = 100;
      const telemetry = makeDynamoBrainQueryTelemetry({
        database: makeDynamoDatabase(dynamo.client),
        generateId: async () => ulid(next++),
        now: () => new Date("2026-07-30T12:00:00.000Z"),
      });
      const meters = () =>
        dynamo
          .items("usage")
          .filter((item) => item.itemType === "meter-event")
          .map((item) => Schema.decodeUnknownSync(MeterEventRecord)(item).data.idempotencyKey);
      const attempts = () =>
        dynamo.items("execution").filter((item) => item.itemType === "brain-query-attempt").length;
      const record = (operationId?: string) =>
        telemetry.record({
          authorizedBrainIds: [ulid(1)],
          candidateCount: 1,
          canonicalDropCount: 0,
          context: {
            environmentId: ulid(7),
            ...(operationId ? { operationId } : {}),
            projectId: ulid(6),
            purpose: "brain-api",
            workspaceId: undefined,
          },
          emittedCount: 1,
          latencyMs: 40,
          organizationId,
          placementGeneration: 1,
          purpose: "ask-evidence",
          query: "quarterly plan",
          results: [
            {
              citation: {
                brainId: ulid(1),
                chunkId: "chunk-0",
                coordinates: { end: 12, kind: "unicode-scalar", start: 0 },
                documentId: ulid(3),
                documentVersionId: ulid(4),
                renditionId: ulid(5),
                sourceId: ulid(2),
              },
              excerpt: "excerpt",
              score: 0.9,
              sensitivity: "internal",
            },
          ],
          target: {
            location: {},
            providerId: "aws-native",
            schemaGeneration: 1,
            targetId: ulid(8),
          },
        });
      return { attempts, meters, record, telemetry };
    }

    test("bills one retrieval for an ask resent after its deadline passed past the meter", async () => {
      const stored = storedTelemetry();
      const provider = {
        providerId: "aws-native",
        search: async () => [],
        target: { location: {}, providerId: "aws-native", schemaGeneration: 1, targetId: ulid(8) },
      } as unknown as BrainSearchProviderClient;
      const reached = Promise.withResolvers<void>();
      let synthesisCalls = 0;
      const runtime = makeBrainQueryRuntime({
        answerModel: {
          synthesize: async ({ signal }) => {
            synthesisCalls += 1;
            if (synthesisCalls > 1) return { claims: [], gaps: ["none"] };
            reached.resolve();
            const { promise, reject } = Promise.withResolvers<never>();
            signal?.addEventListener("abort", () => reject(signal.reason));
            return promise;
          },
        },
        embeddings: { embedQuery: async () => [0.1] },
        hydrator: { hydrateExcerpt: async () => "" },
        placement: {
          resolve: async () => ({ placementGeneration: 1, provider, target: provider.target }),
        },
        repository: {} as BrainRepository,
        telemetry: stored.telemetry,
      });
      const brain: Brain = {
        createdAt: "2026-07-30T12:00:00.000Z",
        createdByPrincipalId: ulid(9),
        id: ulid(1),
        kind: "company",
        maintenancePolicy: {},
        name: "Company",
        organizationId,
        ownershipGeneration: 0,
        retrievalPolicy: {},
        schemaVersion: 1,
        sensitivity: "internal",
        slug: "company",
        status: "active",
        updatedAt: "2026-07-30T12:00:00.000Z",
        updatedByPrincipalId: ulid(9),
        version: 0,
      };
      const ask = (signal?: AbortSignal) =>
        runtime.ask({
          authorizeDisclosure: async () => brain,
          brainIds: [brain.id],
          brains: [brain],
          organizationId,
          question: "quarterly plan",
          ...(signal ? { signal } : {}),
          telemetryContext: {
            environmentId: ulid(7),
            operationId: "brain-ask-1",
            projectId: ulid(6),
            purpose: "brain-api",
            workspaceId: undefined,
          },
        });
      const deadline = new AbortController();

      const timedOut = ask(deadline.signal);
      await reached.promise;
      deadline.abort(new Error("deadline passed"));
      const timeout = await timedOut.then(
        () => "answered",
        (error: unknown) => error,
      );
      const billedBeforeResend = stored.meters();
      const resent = await ask();

      expect(stored.meters()).toEqual(["brain-query:brain-ask-1"]);
      expect(timeout).toMatchObject({ message: "deadline passed" });
      expect(billedBeforeResend).toEqual(["brain-query:brain-ask-1"]);
      expect(stored.attempts()).toBe(2);
      expect(resent).toEqual({
        claims: [],
        gaps: ["none"],
        queryAttemptId: ulid(102),
        usedCitations: [],
      });
    });

    test("bills one retrieval when two attempts under one idempotency key race", async () => {
      const stored = storedTelemetry();

      await Promise.all([stored.record("brain-ask-1"), stored.record("brain-ask-1")]);

      expect(stored.attempts()).toBe(2);
      expect(stored.meters()).toEqual(["brain-query:brain-ask-1"]);
    });

    test("bills every query that carries no idempotency key", async () => {
      const stored = storedTelemetry();

      await stored.record();
      await stored.record();

      expect(stored.meters().toSorted()).toEqual([
        `brain-query:${ulid(100)}`,
        `brain-query:${ulid(103)}`,
      ]);
    });
  });
});
