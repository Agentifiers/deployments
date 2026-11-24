import { describe, expect, test } from "bun:test";
import type {
  Brain,
  BrainDocument,
  BrainDocumentRendition,
  BrainDocumentVersion,
  BrainRepository,
  BrainSearchProviderClient,
  BrainSearchProviderHit,
  BrainSource,
} from "./index.ts";
import { makeBrainQueryRuntime } from "./query-runtime.ts";
import {
  type BrainS3RenditionTransport,
  makeS3BrainRenditionHydrator,
} from "./rendition-hydrator.ts";

function brain(id: string): Brain {
  return {
    createdAt: "2026-07-31T00:00:00.000Z",
    createdByPrincipalId: "principal-1",
    id,
    kind: "company",
    maintenancePolicy: {},
    name: id,
    organizationId: "organization-1",
    ownershipGeneration: 0,
    retrievalPolicy: {},
    schemaVersion: 1,
    sensitivity: "internal",
    slug: id,
    status: "active",
    updatedAt: "2026-07-31T00:00:00.000Z",
    updatedByPrincipalId: "principal-1",
    version: 0,
  };
}

describe("Brain query runtime", () => {
  test("intersects the requested Brain IDs with the caller-authorized Brain objects", async () => {
    const authorizedBrainIds: string[][] = [];
    const provider = {
      providerId: "aws-native",
      search: async (input: { readonly authorizedBrainIds: readonly string[] }) => {
        authorizedBrainIds.push([...input.authorizedBrainIds]);
        return [];
      },
      target: {
        location: {},
        providerId: "aws-native",
        schemaGeneration: 1,
        targetId: "target-1",
      },
    } as unknown as BrainSearchProviderClient;
    const runtime = makeBrainQueryRuntime({
      answerModel: {} as never,
      embeddings: { embedQuery: async () => [0.1, 0.2] },
      hydrator: { hydrateExcerpt: async () => "" },
      placement: {
        resolve: async () => ({
          placementGeneration: 1,
          provider,
          target: provider.target,
        }),
      },
      repository: {} as BrainRepository,
      telemetry: { record: async () => ({ queryAttemptId: "attempt-1" }) },
    });

    const response = await runtime.search({
      authorizeDisclosure: async (brainId) => brain(brainId),
      brainIds: ["brain-requested"],
      brains: [brain("brain-requested"), brain("brain-not-requested")],
      organizationId: "organization-1",
      query: "decision",
    });

    expect(authorizedBrainIds).toEqual([["brain-requested"]]);
    expect(response).toEqual({ queryAttemptId: "attempt-1", results: [] });
  });

  test.each(["embedding", "answer"] as const)(
    "stops an ask when the caller's deadline passes during the %s model call",
    async (stalled) => {
      const deadline = new AbortController();
      const reached = Promise.withResolvers<void>();
      const stall = async (signal: AbortSignal | undefined) => {
        reached.resolve();
        if (!signal) throw new Error(`The ${stalled} call ran without a deadline.`);
        const { promise, reject } = Promise.withResolvers<never>();
        signal.addEventListener("abort", () => reject(signal.reason));
        return promise;
      };
      const provider = {
        providerId: "aws-native",
        search: async () => [],
        target: { location: {}, providerId: "aws-native", schemaGeneration: 1, targetId: "t-1" },
      } as unknown as BrainSearchProviderClient;
      const runtime = makeBrainQueryRuntime({
        answerModel: {
          synthesize: async (input) =>
            stalled === "answer" ? stall(input.signal) : { claims: [], gaps: ["none"] },
        },
        embeddings: {
          embedQuery: async (input) => (stalled === "embedding" ? stall(input.signal) : [0.1]),
        },
        hydrator: { hydrateExcerpt: async () => "" },
        placement: {
          resolve: async () => ({ placementGeneration: 1, provider, target: provider.target }),
        },
        repository: {} as BrainRepository,
        telemetry: { record: async () => ({ queryAttemptId: "attempt-1" }) },
      });

      const answer = runtime.ask({
        authorizeDisclosure: async (brainId) => brain(brainId),
        brainIds: ["brain-1"],
        brains: [brain("brain-1")],
        organizationId: "organization-1",
        question: "decision",
        signal: deadline.signal,
      });
      await reached.promise;
      deadline.abort(new Error("deadline passed"));

      expect(answer).rejects.toThrow("deadline passed");
    },
    1_000,
  );
});

describe("Brain query hydration", () => {
  const organizationId = "organization-1";
  const createdAt = "2026-07-31T00:00:00.000Z";
  const body = new TextEncoder().encode(
    Array.from({ length: 60 }, (_, index) => `word${String(index).padStart(2, "0")} `).join(""),
  );
  const bodyRef = {
    bucket: "content",
    byteSize: body.byteLength,
    contentType: "text/plain",
    key: "organizations/organization-1/version-1",
    sha256: "sha256:content",
    versionId: "s3-version-1",
  };
  const source: BrainSource = {
    brainId: "brain-1",
    createdAt,
    createdByPrincipalId: "principal-1",
    id: "source-1",
    kind: "upload",
    name: "Uploads",
    organizationId,
    status: "active",
    updatedAt: createdAt,
    updatedByPrincipalId: "principal-1",
    version: 0,
  };
  const document: BrainDocument = {
    brainId: "brain-1",
    createdAt,
    currentContentVersionId: "version-1",
    currentEnvelopeHash: "envelope",
    currentSourceOrder: 1,
    currentVersionId: "version-1",
    externalItemIdentity: "decision-log",
    id: "document-1",
    lifecycle: "active",
    organizationId,
    projectionGeneration: 1,
    reviewStatus: "approved",
    sensitivity: "internal",
    sourceId: "source-1",
    title: "Decision log",
    updatedAt: createdAt,
    version: 0,
  };
  const version: BrainDocumentVersion = {
    bodyRef,
    brainId: "brain-1",
    byteSize: body.byteLength,
    contentHash: "sha256:content",
    createdAt,
    documentId: "document-1",
    envelopeHash: "envelope",
    id: "version-1",
    kind: "content",
    mediaType: "text/plain",
    organizationId,
    originalRenditionId: "rendition-1",
    sourceId: "source-1",
    sourceOrder: 1,
  };
  const rendition: BrainDocumentRendition = {
    bodyRef,
    brainId: "brain-1",
    contentHash: "sha256:content",
    coordinateSystem: "utf8-byte",
    createdAt,
    documentId: "document-1",
    documentVersionId: "version-1",
    id: "rendition-1",
    kind: "original",
    organizationId,
  };
  const hits = Array.from(
    { length: 60 },
    (_, index): BrainSearchProviderHit => ({
      brainId: "brain-1",
      chunkId: `chunk-${index}`,
      contentHash: "sha256:content",
      coordinates: { end: index * 7 + 6, kind: "utf8-byte", start: index * 7 },
      denseScore: 0.8,
      documentId: "document-1",
      documentVersionId: index > 10 && index % 6 === 5 ? "stale-version" : "version-1",
      organizationId,
      projectionGeneration: 1,
      renditionId: "rendition-1",
      reviewStatus: "approved",
      schemaGeneration: 1,
      sensitivity: "internal",
      sourceId: "source-1",
    }),
  );

  function roundTripStore() {
    const pending: (() => void)[] = [];
    return {
      pending,
      read: <Value>(value: Value) => {
        const { promise, resolve } = Promise.withResolvers<Value>();
        pending.push(() => resolve(value));
        return promise;
      },
    };
  }

  async function completeRoundTrips(pending: (() => void)[], limit = Number.POSITIVE_INFINITY) {
    for (let roundTrips = 0; ; roundTrips += 1) {
      const idle = Promise.withResolvers<void>();
      setImmediate(idle.resolve);
      await idle.promise;
      if (pending.length === 0 || roundTrips === limit) return roundTrips;
      for (const complete of pending.splice(0).reverse()) complete();
    }
  }

  function countedReads(read: <Value>(value: Value) => Promise<Value>) {
    const counted = {
      read: <Value>(value: Value) => {
        counted.reads += 1;
        return read(value);
      },
      reads: 0,
    };
    return counted;
  }

  function abortableRangeReads(
    storeRead: <Value>(value: Value) => Promise<Value>,
    failingRange?: string,
  ) {
    const reads = { aborted: 0, started: 0 };
    const getObject: BrainS3RenditionTransport["getObject"] = async (
      { Range },
      { abortSignal },
    ) => {
      reads.started += 1;
      if (Range === failingRange) throw new Error("rendition read failed");
      const [start, end] = (/^bytes=(\d+)-(\d+)$/u.exec(Range ?? "") ?? []).slice(1).map(Number);
      const read = Promise.withResolvers<Uint8Array>();
      const abort = () => {
        reads.aborted += 1;
        read.reject(abortSignal!.reason);
      };
      if (abortSignal?.aborted) abort();
      abortSignal?.addEventListener("abort", abort, { once: true });
      void storeRead(body.slice(start, end! + 1)).then((bytes) => {
        abortSignal?.removeEventListener("abort", abort);
        read.resolve(bytes);
      });
      const bytes = await read.promise;
      return { Body: { transformToByteArray: async () => bytes } };
    };
    return { getObject, reads };
  }

  function runtime(
    read: <Value>(value: Value) => Promise<Value>,
    getObject: BrainS3RenditionTransport["getObject"],
  ) {
    const provider = {
      providerId: "aws-native",
      search: async () => hits,
      target: { location: {}, providerId: "aws-native", schemaGeneration: 1, targetId: "t-1" },
    } as unknown as BrainSearchProviderClient;
    return makeBrainQueryRuntime({
      answerModel: {} as never,
      embeddings: { embedQuery: async () => [0.1] },
      hydrator: makeS3BrainRenditionHydrator({ getObject }),
      placement: {
        resolve: async () => ({ placementGeneration: 1, provider, target: provider.target }),
      },
      repository: {
        get: () => read(brain("brain-1")),
        getDocument: () => read(document),
        getDocumentRendition: () => read(rendition),
        getDocumentVersion: () => read(version),
        getSource: () => read(source),
      } as unknown as BrainRepository,
      telemetry: { record: async () => ({ queryAttemptId: "attempt-1" }) },
    });
  }

  test("hydrates 50 hits ten at a time in a few round trips and keeps rank order", async () => {
    const store = roundTripStore();
    let renditionReads = 0;
    let maxRenditionReads = 0;
    const query = runtime(store.read, async ({ Range }) => {
      const [start, end] = (/^bytes=(\d+)-(\d+)$/u.exec(Range ?? "") ?? []).slice(1).map(Number);
      renditionReads += 1;
      maxRenditionReads = Math.max(maxRenditionReads, renditionReads);
      const bytes = await store.read(body.slice(start, end! + 1));
      renditionReads -= 1;
      return { Body: { transformToByteArray: async () => bytes } };
    });

    const response = query.search({
      authorizeDisclosure: (brainId) => store.read(brain(brainId)),
      brainIds: ["brain-1"],
      brains: [brain("brain-1")],
      limit: 50,
      organizationId,
      query: "decision",
    });
    const roundTrips = await completeRoundTrips(store.pending);
    const { results } = await response;

    expect({ maxRenditionReads, roundTrips }).toEqual({ maxRenditionReads: 10, roundTrips: 9 });
    expect(results.map((result) => result.excerpt)).toEqual(
      Array.from({ length: 58 }, (_, index) => index)
        .filter((index) => index <= 10 || index % 6 !== 5)
        .map((index) => `word${String(index).padStart(2, "0")}`),
    );
    expect(results[11]?.excerpt).toBe("word12");
    expect(results[49]?.citation).toEqual({
      brainId: "brain-1",
      chunkId: "chunk-57",
      coordinates: { end: 405, kind: "utf8-byte", start: 399 },
      documentId: "document-1",
      documentVersionId: "version-1",
      renditionId: "rendition-1",
      sourceId: "source-1",
    });
  });

  test("aborts every in-flight rendition read at the deadline and starts no more", async () => {
    const store = roundTripStore();
    const deadline = new AbortController();
    const started: string[] = [];
    const aborted: string[] = [];
    const query = runtime(store.read, async ({ Range }, options) => {
      started.push(Range!);
      const stalled = Promise.withResolvers<never>();
      options?.abortSignal?.addEventListener("abort", () => {
        aborted.push(Range!);
        stalled.reject(options.abortSignal!.reason);
      });
      return stalled.promise;
    });
    let outcome = "still running";
    void query
      .search({
        authorizeDisclosure: (brainId) => store.read(brain(brainId)),
        brainIds: ["brain-1"],
        brains: [brain("brain-1")],
        limit: 50,
        organizationId,
        query: "decision",
        signal: deadline.signal,
      })
      .then(
        () => (outcome = "answered"),
        (cause: Error) => (outcome = cause.message),
      );

    await completeRoundTrips(store.pending);
    deadline.abort(new Error("deadline passed"));
    await completeRoundTrips(store.pending);

    expect({ aborted: aborted.length, outcome, started: started.length }).toEqual({
      aborted: 10,
      outcome: "deadline passed",
      started: 10,
    });
  });

  test("a failing hit aborts its nine siblings' rendition reads", async () => {
    const store = roundTripStore();
    const canonical = countedReads(store.read);
    const s3 = abortableRangeReads(store.read, "bytes=0-5");
    const outcome = runtime(canonical.read, s3.getObject)
      .search({
        authorizeDisclosure: (brainId) => canonical.read(brain(brainId)),
        brainIds: ["brain-1"],
        brains: [brain("brain-1")],
        limit: 50,
        organizationId,
        query: "decision",
      })
      .then(
        () => "answered",
        (cause: Error) => cause.message,
      );

    await completeRoundTrips(store.pending);

    expect({ canonicalReads: canonical.reads, outcome: await outcome, ...s3.reads }).toEqual({
      aborted: 9,
      canonicalReads: 5,
      outcome: "rendition read failed",
      started: 10,
    });
  });

  test("a deadline during canonical reads stops every check before its rendition read", async () => {
    const store = roundTripStore();
    const canonical = countedReads(store.read);
    const s3 = abortableRangeReads(store.read);
    const deadline = new AbortController();
    const outcome = runtime(canonical.read, s3.getObject)
      .search({
        authorizeDisclosure: (brainId) => canonical.read(brain(brainId)),
        brainIds: ["brain-1"],
        brains: [brain("brain-1")],
        limit: 50,
        organizationId,
        query: "decision",
        signal: deadline.signal,
      })
      .then(
        () => "answered",
        (cause: Error) => cause.message,
      );

    await completeRoundTrips(store.pending, 1);
    deadline.abort(new Error("deadline passed"));
    await completeRoundTrips(store.pending);

    expect({ canonicalReads: canonical.reads, outcome: await outcome, ...s3.reads }).toEqual({
      aborted: 0,
      canonicalReads: 5,
      outcome: "deadline passed",
      started: 0,
    });
  });
});
