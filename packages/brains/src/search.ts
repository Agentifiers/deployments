import type {
  Brain,
  BrainDocument,
  BrainDocumentRendition,
  BrainDocumentVersion,
  BrainSensitivity,
  BrainSource,
} from "./models.ts";
import type {
  BrainSearchProviderClient,
  BrainSearchProviderHit,
  BrainSearchTarget,
} from "./search-provider.ts";

export interface BrainSearchCitation {
  readonly brainId: string;
  readonly chunkId: string;
  readonly coordinates: BrainSearchProviderHit["coordinates"];
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly renditionId: string;
  readonly sourceId: string;
}

export interface BrainSearchResult {
  readonly citation: BrainSearchCitation;
  readonly excerpt: string;
  readonly score: number;
  readonly sensitivity: BrainSensitivity;
  readonly title?: string;
}

export interface BrainCanonicalSearchPort {
  /**
   * Point-reads and reauthorizes the Brain while the provider search runs, and again once every hit
   * is hydrated. Hits are checked against the Brain it returns, so archiving a Brain stops its
   * disclosure on every path.
   */
  readonly authorizeDisclosure: (brainId: string) => Promise<Brain | undefined>;
  readonly getDocument: (brainId: string, documentId: string) => Promise<BrainDocument | undefined>;
  readonly getSource: (brainId: string, sourceId: string) => Promise<BrainSource | undefined>;
  readonly getRendition: (
    documentVersionId: string,
    renditionId: string,
  ) => Promise<BrainDocumentRendition | undefined>;
  readonly getVersion: (
    documentId: string,
    versionId: string,
  ) => Promise<BrainDocumentVersion | undefined>;
  readonly hydrate: (input: BrainHydrationRequest) => Promise<string>;
}

export interface BrainHydrationRequest {
  readonly hit: BrainSearchProviderHit;
  readonly rendition: BrainDocumentRendition;
  readonly signal?: AbortSignal;
}

export interface SearchBrainsInput {
  readonly allowedReviewStatuses?: readonly BrainDocument["reviewStatus"][];
  readonly allowedSensitivities?: readonly BrainSensitivity[];
  /** Brains the caller was authorized to read when the query started. */
  readonly brains: readonly Brain[];
  readonly canonical: BrainCanonicalSearchPort;
  readonly embedding: readonly number[];
  readonly limit: number;
  readonly organizationId: string;
  readonly provider: BrainSearchProviderClient;
  readonly query: string;
  readonly retentionCutoffMs?: number;
  readonly signal?: AbortSignal;
  readonly target: BrainSearchTarget;
  readonly telemetry?: (input: {
    readonly candidateCount: number;
    readonly canonicalDropCount: number;
    readonly emittedCount: number;
  }) => void;
}

const HIT_VALIDATION_CONCURRENCY = 10;

function providerScore(hit: BrainSearchProviderHit) {
  const dense = hit.denseScore ?? 0;
  const lexical = hit.lexicalScore ?? 0;
  const exact = hit.exactScore ?? 0;
  const entity = hit.entityScore ?? 0;
  return Math.max(0, Math.min(1, dense * 0.5 + lexical * 0.25 + exact * 0.15 + entity * 0.1));
}

function targetMatches(provider: BrainSearchProviderClient, target: BrainSearchTarget) {
  return (
    provider.providerId === target.providerId &&
    provider.target.targetId === target.targetId &&
    provider.target.schemaGeneration === target.schemaGeneration
  );
}

function readOnce<Key extends readonly string[], Value>(
  read: (...key: Key) => Promise<Value>,
): (...key: Key) => Promise<Value> {
  const reads = new Map<string, Promise<Value>>();
  return (...key) => {
    const id = key.join("\u0000");
    const pending = reads.get(id) ?? read(...key);
    reads.set(id, pending);
    return pending;
  };
}

interface HydratedHit {
  readonly brain: Brain;
  readonly document: BrainDocument;
  readonly hit: BrainSearchProviderHit;
  readonly result: BrainSearchResult;
  readonly source: BrainSource;
  readonly version: BrainDocumentVersion;
}

type DisclosureReads = Pick<
  BrainCanonicalSearchPort,
  "authorizeDisclosure" | "getDocument" | "getSource" | "getVersion"
>;

async function validateHit(
  canonical: BrainCanonicalSearchPort,
  brains: ReadonlyMap<string, Brain>,
  hit: BrainSearchProviderHit,
  signal: AbortSignal,
): Promise<HydratedHit | undefined> {
  const brain = brains.get(hit.brainId);
  if (!brain || hit.organizationId !== brain.organizationId) return undefined;
  const [source, document, version, rendition] = await Promise.all([
    canonical.getSource(hit.brainId, hit.sourceId),
    canonical.getDocument(hit.brainId, hit.documentId),
    canonical.getVersion(hit.documentId, hit.documentVersionId),
    canonical.getRendition(hit.documentVersionId, hit.renditionId),
  ]);
  if (
    !source ||
    source.organizationId !== brain.organizationId ||
    source.brainId !== brain.id ||
    source.status !== "active" ||
    !document ||
    document.organizationId !== brain.organizationId ||
    document.brainId !== brain.id ||
    document.sourceId !== source.id ||
    document.lifecycle !== "active" ||
    document.currentContentVersionId !== hit.documentVersionId ||
    document.projectionGeneration !== hit.projectionGeneration ||
    document.reviewStatus !== hit.reviewStatus ||
    document.sensitivity !== hit.sensitivity ||
    !version ||
    version.organizationId !== brain.organizationId ||
    version.brainId !== brain.id ||
    version.sourceId !== source.id ||
    version.documentId !== document.id ||
    version.id !== hit.documentVersionId ||
    version.contentHash !== hit.contentHash ||
    !rendition ||
    rendition.organizationId !== brain.organizationId ||
    rendition.brainId !== brain.id ||
    rendition.documentId !== document.id ||
    rendition.documentVersionId !== version.id ||
    rendition.id !== hit.renditionId ||
    rendition.contentHash !== version.contentHash
  ) {
    return undefined;
  }
  signal.throwIfAborted();
  const excerpt = await canonical.hydrate({ hit, rendition, signal });
  signal.throwIfAborted();
  return {
    brain,
    document,
    hit,
    result: {
      citation: {
        brainId: hit.brainId,
        chunkId: hit.chunkId,
        coordinates: hit.coordinates,
        documentId: hit.documentId,
        documentVersionId: hit.documentVersionId,
        renditionId: hit.renditionId,
        sourceId: hit.sourceId,
      },
      excerpt,
      score: providerScore(hit),
      sensitivity: hit.sensitivity,
      ...(document.title ? { title: document.title } : {}),
    },
    source,
    version,
  };
}

async function unchangedAtDisclosure(
  current: DisclosureReads,
  { brain, document, hit, source, version }: HydratedHit,
): Promise<boolean> {
  const [currentBrain, currentSource, currentDocument, currentVersion] = await Promise.all([
    current.authorizeDisclosure(hit.brainId),
    current.getSource(hit.brainId, hit.sourceId),
    current.getDocument(hit.brainId, hit.documentId),
    current.getVersion(hit.documentId, hit.documentVersionId),
  ]);
  return (
    currentBrain?.version === brain.version &&
    currentBrain.organizationId === brain.organizationId &&
    currentBrain.status === "active" &&
    currentSource?.version === source.version &&
    currentSource.status === "active" &&
    currentDocument?.version === document.version &&
    currentDocument.lifecycle === "active" &&
    currentDocument.currentContentVersionId === version.id &&
    currentDocument.projectionGeneration === hit.projectionGeneration &&
    currentVersion?.id === version.id &&
    currentVersion.contentHash === version.contentHash
  );
}

export async function searchBrains(
  input: SearchBrainsInput,
): Promise<readonly BrainSearchResult[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new TypeError("Brain search limit must be between 1 and 100.");
  }
  if (!targetMatches(input.provider, input.target)) {
    throw new TypeError("Brain search provider is not bound to the selected physical target.");
  }
  const admitted = input.brains.filter(
    (brain) => brain.organizationId === input.organizationId && brain.status === "active",
  );
  if (admitted.length === 0) return [];
  const [hits, disclosable] = await Promise.all([
    input.provider.search({
      allowedReviewStatuses: input.allowedReviewStatuses ?? ["approved", "unreviewed"],
      allowedSensitivities: input.allowedSensitivities ?? [
        "public",
        "internal",
        "confidential",
        "restricted",
      ],
      authorizedBrainIds: admitted.map((brain) => brain.id),
      embedding: input.embedding,
      limit: Math.min(500, input.limit * 5),
      organizationId: input.organizationId,
      query: input.query,
      retentionCutoffMs: input.retentionCutoffMs ?? Date.now(),
      ...(input.signal ? { signal: input.signal } : {}),
    }),
    Promise.all(admitted.map((brain) => input.canonical.authorizeDisclosure(brain.id))),
  ]);
  const brains = new Map(
    disclosable
      .filter(
        (brain): brain is Brain =>
          brain?.organizationId === input.organizationId && brain.status === "active",
      )
      .map((brain) => [brain.id, brain]),
  );
  const canonical: BrainCanonicalSearchPort = {
    ...input.canonical,
    getDocument: readOnce(input.canonical.getDocument),
    getRendition: readOnce(input.canonical.getRendition),
    getSource: readOnce(input.canonical.getSource),
    getVersion: readOnce(input.canonical.getVersion),
  };
  const outcomes: (HydratedHit | undefined)[] = [];
  const checks = new AbortController();
  const { promise, reject, resolve } = Promise.withResolvers<void>();
  const stop = (cause: unknown) => {
    checks.abort(cause);
    reject(cause);
  };
  const abort = () => stop(input.signal?.reason);
  let next = 0;
  let inFlight = 0;
  let emitted = 0;
  const launch = () => {
    while (
      !checks.signal.aborted &&
      inFlight < HIT_VALIDATION_CONCURRENCY &&
      emitted + inFlight < input.limit &&
      next < hits.length
    ) {
      const index = next;
      next += 1;
      inFlight += 1;
      validateHit(canonical, brains, hits[index]!, checks.signal).then((result) => {
        inFlight -= 1;
        outcomes[index] = result;
        if (result) emitted += 1;
        launch();
      }, stop);
    }
    if (inFlight === 0) resolve();
  };
  input.signal?.throwIfAborted();
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    launch();
    await promise;
  } finally {
    input.signal?.removeEventListener("abort", abort);
  }
  const hydrated = outcomes.filter((outcome) => outcome !== undefined);
  const current: DisclosureReads = {
    authorizeDisclosure: readOnce(input.canonical.authorizeDisclosure),
    getDocument: readOnce(input.canonical.getDocument),
    getSource: readOnce(input.canonical.getSource),
    getVersion: readOnce(input.canonical.getVersion),
  };
  const unchanged = await Promise.all(
    hydrated.map((outcome) => unchangedAtDisclosure(current, outcome)),
  );
  const results = hydrated.filter((_, index) => unchanged[index]).map((outcome) => outcome.result);
  input.telemetry?.({
    candidateCount: hits.length,
    canonicalDropCount: hits.length - results.length,
    emittedCount: results.length,
  });
  return results;
}
