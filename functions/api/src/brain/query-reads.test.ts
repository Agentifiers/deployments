import { describe, expect, test } from "bun:test";
import {
  makeBrainQueryRuntime,
  makeS3BrainRenditionHydrator,
  type Brain,
  type BrainDocument,
  type BrainDocumentRendition,
  type BrainDocumentVersion,
  type BrainGrant,
  type BrainSearchProviderClient,
  type BrainSearchProviderHit,
} from "@deployments-ai/brains";
import { PersistenceError, type DynamoDatabaseService } from "@deployments-ai/db";
import {
  brain,
  brainId,
  environmentId,
  humanIdentity,
  invocation,
  liveHumanRecords,
  organizationId,
  ownerGrant,
  projectId,
  repository,
  service,
  source,
  sourceId,
  timestamp,
} from "./service.fixture.ts";

type Access = "dynamodb-read" | "dynamodb-write" | "model" | "opensearch" | "s3";

const excerpt = new TextEncoder().encode("evidence");
const target = {
  location: {},
  providerId: "aws-native" as const,
  schemaGeneration: 1,
  targetId: "target-1",
};

function documentParts(index: number) {
  const documentId = `document-${index}`;
  const versionId = `version-${index}`;
  const renditionId = `rendition-${index}`;
  const bodyRef = {
    bucket: "content",
    byteSize: excerpt.byteLength,
    contentType: "text/plain",
    key: `${documentId}/original`,
    sha256: `sha256:${documentId}`,
    versionId: "s3-version-1",
  };
  const document: BrainDocument = {
    brainId,
    createdAt: timestamp,
    currentContentVersionId: versionId,
    currentEnvelopeHash: "envelope",
    currentSourceOrder: 1,
    currentVersionId: versionId,
    externalItemIdentity: documentId,
    id: documentId,
    lifecycle: "active",
    organizationId,
    projectionGeneration: 1,
    reviewStatus: "approved",
    sensitivity: "internal",
    sourceId,
    title: documentId,
    updatedAt: timestamp,
    version: 0,
  };
  const version: BrainDocumentVersion = {
    bodyRef,
    brainId,
    byteSize: excerpt.byteLength,
    contentHash: bodyRef.sha256,
    createdAt: timestamp,
    documentId,
    envelopeHash: "envelope",
    id: versionId,
    kind: "content",
    mediaType: "text/plain",
    organizationId,
    originalRenditionId: renditionId,
    sourceId,
    sourceOrder: 1,
  };
  const rendition: BrainDocumentRendition = {
    bodyRef,
    brainId,
    contentHash: bodyRef.sha256,
    coordinateSystem: "utf8-byte",
    createdAt: timestamp,
    documentId,
    documentVersionId: versionId,
    id: renditionId,
    kind: "original",
    organizationId,
  };
  return { document, rendition, version };
}

const documents = Array.from({ length: 5 }, (_, index) => documentParts(index));

function hit(index: number): BrainSearchProviderHit {
  const { document, rendition } = documents[index % documents.length]!;
  return {
    brainId,
    chunkId: `chunk-${index}`,
    contentHash: rendition.contentHash,
    coordinates: { end: excerpt.byteLength, kind: "utf8-byte", start: 0 },
    denseScore: 0.8,
    documentId: document.id,
    documentVersionId: document.currentContentVersionId!,
    organizationId,
    projectionGeneration: 1,
    renditionId: rendition.id,
    reviewStatus: "approved",
    schemaGeneration: 1,
    sensitivity: "internal",
    sourceId,
  };
}

interface RoundTrips {
  readonly counts: Record<Access, number>;
  readonly send: <Value>(access: Access, value: Value) => Promise<Value>;
  readonly sequentialDepth: () => Promise<number>;
}

interface CanonicalState {
  readonly brain?: Brain;
  readonly documentLifecycle?: BrainDocument["lifecycle"];
  /** The active grant each successive grant lookup sees; the last one repeats. */
  readonly grants?: readonly (BrainGrant | undefined)[];
}

interface QueryState extends CanonicalState {
  /** The canonical state every read sees once S3 starts returning hit content. */
  readonly atHydration?: CanonicalState;
}

function roundTrips(): RoundTrips {
  const pending: (() => void)[] = [];
  const counts: Record<Access, number> = {
    "dynamodb-read": 0,
    "dynamodb-write": 0,
    model: 0,
    opensearch: 0,
    s3: 0,
  };
  return {
    counts,
    send<Value>(access: Access, value: Value) {
      counts[access] += 1;
      const { promise, resolve } = Promise.withResolvers<Value>();
      pending.push(() => resolve(value));
      return promise;
    },
    async sequentialDepth() {
      for (let depth = 0; ; depth += 1) {
        const idle = Promise.withResolvers<void>();
        setImmediate(idle.resolve);
        await idle.promise;
        if (pending.length === 0) return depth;
        for (const complete of pending.splice(0)) complete();
      }
    },
  };
}

function platform(store: RoundTrips, state: QueryState = {}) {
  const records = liveHumanRecords();
  const database: DynamoDatabaseService = {
    deleteRecord: async () => {},
    getRecord: (_table, key) => store.send("dynamodb-read", records[`${key.pk}|${key.sk}`]),
    putRecord: async () => {},
    queryRecords: async () => ({ items: [] }),
    transactWrite: async () => {},
  };
  let current: CanonicalState = state;
  let grantLookups = 0;
  const canonical = repository({
    findActiveGrant: async () => {
      const grants = current.grants ?? [ownerGrant];
      const grant = grants[Math.min(grantLookups, grants.length - 1)];
      grantLookups += 1;
      await store.send("dynamodb-read", "grant uniqueness claim");
      return store.send("dynamodb-read", grant);
    },
    get: () => store.send("dynamodb-read", current.brain ?? brain),
    getDocument: (_organizationId, _brainId, documentId) => {
      const document = documents.find((parts) => parts.document.id === documentId)?.document;
      return store.send(
        "dynamodb-read",
        document && current.documentLifecycle
          ? { ...document, lifecycle: current.documentLifecycle, version: document.version + 1 }
          : document,
      );
    },
    getDocumentRendition: (_organizationId, _versionId, renditionId) =>
      store.send(
        "dynamodb-read",
        documents.find(({ rendition }) => rendition.id === renditionId)?.rendition,
      ),
    getDocumentVersion: (_organizationId, _documentId, versionId) =>
      store.send(
        "dynamodb-read",
        documents.find(({ version }) => version.id === versionId)?.version,
      ),
    getSource: () => store.send("dynamodb-read", source),
  });
  const provider = {
    providerId: "aws-native",
    search: ({ limit }: { readonly limit: number }) =>
      store.send(
        "opensearch",
        Array.from({ length: limit }, (_, index) => hit(index)),
      ),
    target,
  } as unknown as BrainSearchProviderClient;
  const brainQueryRuntime = makeBrainQueryRuntime({
    answerModel: {} as never,
    embeddings: {
      embedQuery: async () => {
        await store.send("dynamodb-read", "search placement");
        await store.send("dynamodb-read", "embedding profile");
        const embedding = await store.send("model", [0.1, 0.2]);
        await store.send("dynamodb-write", "embedding usage");
        return embedding;
      },
    },
    hydrator: makeS3BrainRenditionHydrator({
      getObject: async () => {
        current = { ...state, ...state.atHydration };
        const bytes = await store.send("s3", excerpt);
        return { Body: { transformToByteArray: async () => bytes } };
      },
    }),
    placement: {
      resolve: async () => {
        await store.send("dynamodb-read", "search placement");
        await store.send("opensearch", "placement readiness");
        return { placementGeneration: 1, provider, target };
      },
    },
    repository: canonical,
    telemetry: {
      record: async () => {
        await store.send("dynamodb-write", "query attempt");
        return { queryAttemptId: "query-attempt-1" };
      },
    },
  });
  return service({ brainQueryRuntime, database, repository: canonical });
}

async function search(limit: number, state?: QueryState) {
  const store = roundTrips();
  const response = platform(store, state)
    .invoke(
      "searchBrains",
      invocation({
        body: { brainIds: [brainId], limit, query: "Why?" },
        identity: {
          ...humanIdentity,
          environmentIds: [environmentId],
          projectIds: [projectId],
        },
        idempotencyKey: `brain-search-${limit}`,
        params: {},
      }),
    )
    .then(
      (value) => ({
        emitted:
          value && typeof value === "object" && "results" in value && Array.isArray(value.results)
            ? value.results.length
            : "no results",
      }),
      (cause: unknown) => ({
        rejected: cause instanceof PersistenceError ? cause.code : String(cause),
      }),
    );
  const sequentialDepth = await store.sequentialDepth();
  return { ...(await response), sequentialDepth, ...store.counts };
}

describe("Brain search read structure per query", () => {
  test("10 hits: one admission, then each disclosure check and canonical read once at hydration and once after", async () => {
    expect(await search(10)).toEqual({
      "dynamodb-read": 48,
      "dynamodb-write": 2,
      emitted: 10,
      model: 1,
      opensearch: 2,
      s3: 10,
      sequentialDepth: 16,
    });
  });

  test("50 hits: the same DynamoDB reads as 10 hits", async () => {
    expect(await search(50)).toEqual({
      "dynamodb-read": 48,
      "dynamodb-write": 2,
      emitted: 50,
      model: 1,
      opensearch: 2,
      s3: 50,
      sequentialDepth: 20,
    });
  });

  test("a grant revoked before the query starts blocks every hit", async () => {
    expect(await search(10, { grants: [undefined] })).toEqual({
      "dynamodb-read": 8,
      "dynamodb-write": 0,
      model: 0,
      opensearch: 0,
      rejected: "brain_query_scope_not_found",
      s3: 0,
      sequentialDepth: 5,
    });
  });

  test("a grant revoked after admission blocks disclosure of every hit", async () => {
    expect(await search(10, { grants: [ownerGrant, undefined] })).toEqual({
      "dynamodb-read": 17,
      "dynamodb-write": 2,
      emitted: 0,
      model: 1,
      opensearch: 2,
      s3: 0,
      sequentialDepth: 13,
    });
  });

  test("a Brain archived before the query starts blocks every hit", async () => {
    expect(await search(10, { brain: { ...brain, status: "archived" } })).toEqual({
      "dynamodb-read": 6,
      "dynamodb-write": 0,
      model: 0,
      opensearch: 0,
      rejected: "brain_query_scope_not_found",
      s3: 0,
      sequentialDepth: 3,
    });
  });

  test("a Brain archived, a document archived, or a grant revoked during hydration blocks every hit", async () => {
    const blocked = {
      "dynamodb-read": 48,
      "dynamodb-write": 2,
      emitted: 0,
      model: 1,
      opensearch: 2,
      s3: 10,
      sequentialDepth: 16,
    };
    expect([
      await search(10, {
        atHydration: { brain: { ...brain, status: "archived", version: brain.version + 1 } },
      }),
      await search(10, { atHydration: { documentLifecycle: "archived" } }),
      await search(10, { atHydration: { grants: [undefined] } }),
    ]).toEqual([blocked, blocked, { ...blocked, "dynamodb-read": 50, sequentialDepth: 18 }]);
  });
});
