import { Metadata } from "@deployments-ai/api-contract/primitives";
import { Option, Schema } from "effect";
import {
  GRANT_PERMISSIONS,
  MEMORY_REVIEW_STATUSES,
  MEMORY_SCOPES,
  MEMORY_SENSITIVITIES,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  POLICY_SCOPES,
  RETRIEVAL_STRATEGIES,
  REVIEW_ITEM_STATUSES,
  SENSITIVITY_MODES,
  SPACE_KINDS,
  SPACE_STATUSES,
  USEFULNESS_RATINGS,
  type ImportOutcome,
  type JsonObject,
  type Memory,
  type MemoryPolicy,
  type MemoryQuality,
  type MemoryReviewItem,
  type MemorySearchHit,
  type MemorySearchResult,
  type PolicyRetrieval,
  type MemorySpace,
  type MemorySpaceGrant,
  type RetrievalFeedback,
} from "./model.ts";

export type MemoryDecoder<Item> = (value: unknown) => Item | undefined;

const versionedFields = {
  createdAt: Schema.String,
  id: Schema.String,
  updatedAt: Schema.String,
  version: Schema.Number,
};

const resourceFields = {
  ...versionedFields,
  workspaceId: Schema.optionalKey(Schema.String),
};

const spaceRecord = Schema.decodeUnknownOption(
  Schema.Struct({
    data: Schema.Struct({
      ...resourceFields,
      description: Schema.optionalKey(Schema.String),
      kind: Schema.Literals(SPACE_KINDS),
      name: Schema.String,
      retentionDays: Schema.optionalKey(Schema.Number),
      status: Schema.Literals(SPACE_STATUSES),
    }),
    itemType: Schema.Literal("memory-space"),
  }),
);

const grantRecord = Schema.decodeUnknownOption(
  Schema.Struct({
    data: Schema.Struct({
      ...resourceFields,
      agentDefinitionId: Schema.String,
      memorySpaceId: Schema.String,
      permission: Schema.Literals(GRANT_PERMISSIONS),
      revokedAt: Schema.optionalKey(Schema.String),
    }),
    itemType: Schema.Literal("memory-space-grant"),
  }),
);

const policyRecord = Schema.decodeUnknownOption(
  Schema.Struct({
    data: Schema.Struct({
      ...resourceFields,
      activeRecallEnabled: Schema.Boolean,
      activeRecallRolloutPercent: Schema.Number,
      processingConfig: Schema.optionalKey(Metadata),
      retentionDays: Schema.optionalKey(Schema.Number),
      scope: Schema.Literals(POLICY_SCOPES),
      sensitivityMode: Schema.Literals(SENSITIVITY_MODES),
    }),
    itemType: Schema.Literal("memory-policy"),
  }),
);

const jsonObject = Schema.decodeUnknownOption(Metadata);

const objectOrEmpty = (value: unknown): JsonObject =>
  Option.getOrElse(jsonObject(value), () => ({}));

const SERVED_STRATEGY_FIELDS = ["strategy", "shadowStrategy", "rolloutPercent"] as const;

function policyRetrieval(settings: JsonObject): PolicyRetrieval {
  const rollout = settings["rolloutPercent"];
  const overridden = Object.values(objectOrEmpty(settings["purposes"])).some((purpose) => {
    const fields = objectOrEmpty(purpose);
    return SERVED_STRATEGY_FIELDS.some((field) => fields[field] !== undefined);
  });
  if (
    overridden ||
    settings["shadowStrategy"] !== undefined ||
    (typeof rollout === "number" && rollout < 100)
  ) {
    return "custom";
  }
  return RETRIEVAL_STRATEGIES.find((strategy) => strategy === settings["strategy"]) ?? "default";
}

export const decodeSpace: MemoryDecoder<MemorySpace> = (value) =>
  Option.getOrUndefined(Option.map(spaceRecord(value), (record) => record.data));

export const decodeGrant: MemoryDecoder<MemorySpaceGrant> = (value) =>
  Option.getOrUndefined(
    Option.map(grantRecord(value), ({ data: { revokedAt, ...grant } }) =>
      revokedAt === undefined
        ? { ...grant, status: "active" as const }
        : { ...grant, revokedAt, status: "revoked" as const },
    ),
  );

export const decodePolicy: MemoryDecoder<MemoryPolicy> = (value) =>
  Option.getOrUndefined(
    Option.map(policyRecord(value), ({ data: { processingConfig = {}, ...policy } }) => {
      const settings = objectOrEmpty(processingConfig["memoryRetrieval"]);
      return {
        ...policy,
        processingConfig,
        retrieval: policyRetrieval(settings),
        retrievalSettings: settings,
      };
    }),
  );

function decodeEach<Raw, Item>(
  raws: readonly Raw[],
  decodeItem: (raw: Raw) => Item | undefined,
): Item[] | undefined {
  const items: Item[] = [];
  for (const raw of raws) {
    const item = decodeItem(raw);
    if (item === undefined) return undefined;
    items.push(item);
  }
  return items;
}

const pageShape = Schema.decodeUnknownOption(
  Schema.Struct({
    items: Schema.Array(Schema.Unknown),
    nextCursor: Schema.optionalKey(Schema.String),
  }),
);

export function decodePage<Item>(
  decodeItem: MemoryDecoder<Item>,
): MemoryDecoder<{ readonly items: readonly Item[]; readonly nextCursor?: string }> {
  return (value) => {
    const page = Option.getOrUndefined(pageShape(value));
    const items = page && decodeEach(page.items, decodeItem);
    if (page === undefined || items === undefined) return undefined;
    return page.nextCursor === undefined ? { items } : { items, nextCursor: page.nextCursor };
  };
}

const memoryRecord = Schema.decodeUnknownOption(
  Schema.Struct({
    data: Schema.Struct({
      ...versionedFields,
      body: Schema.optionalKey(Schema.String),
      bodyRef: Schema.optionalKey(Schema.Struct({ byteSize: Schema.Number })),
      entityKeys: Schema.optionalKey(Schema.Array(Schema.String)),
      importance: Schema.optionalKey(Schema.Number),
      memorySpaceId: Schema.String,
      memoryType: Schema.optionalKey(Schema.Literals(MEMORY_TYPES)),
      reviewStatus: Schema.Literals(MEMORY_REVIEW_STATUSES),
      scope: Schema.Literals(MEMORY_SCOPES),
      sensitivity: Schema.Literals(MEMORY_SENSITIVITIES),
      source: Schema.String,
      status: Schema.Literals(MEMORY_STATUSES),
    }),
    itemType: Schema.Literal("memory"),
  }),
);

export const decodeMemory: MemoryDecoder<Memory> = (value) => {
  const record = Option.getOrUndefined(memoryRecord(value));
  if (record === undefined) return undefined;
  const { body, bodyRef, entityKeys = [], status, ...fields } = record.data;
  if (status === "deleted") return { ...fields, entityKeys, status };
  if (body !== undefined) {
    return { ...fields, body: { kind: "inline", text: body }, entityKeys, status };
  }
  if (bodyRef !== undefined) {
    return { ...fields, body: { byteSize: bodyRef.byteSize, kind: "stored" }, entityKeys, status };
  }
  return undefined;
};

const recordData = Schema.decodeUnknownOption(Schema.Struct({ data: Metadata }));

export const decodeExportedMemory: MemoryDecoder<JsonObject> = (value) =>
  decodeMemory(value) === undefined
    ? undefined
    : Option.getOrUndefined(Option.map(recordData(value), (record) => record.data));

const reviewItemRecord = Schema.decodeUnknownOption(
  Schema.Struct({
    data: Schema.Struct({
      ...versionedFields,
      kind: Schema.String,
      memoryId: Schema.String,
      proposedContent: Schema.optionalKey(Schema.String),
      reason: Schema.optionalKey(Schema.String),
      status: Schema.Literals(REVIEW_ITEM_STATUSES),
    }),
    itemType: Schema.Literal("memory-review-item"),
  }),
);

export const decodeReviewItem: MemoryDecoder<MemoryReviewItem> = (value) =>
  Option.getOrUndefined(Option.map(reviewItemRecord(value), (record) => record.data));

const resolutionShape = Schema.decodeUnknownOption(
  Schema.Struct({ memory: Schema.Unknown, review: Schema.Unknown }),
);

export const decodeResolution: MemoryDecoder<{
  readonly memory: Memory;
  readonly review: MemoryReviewItem;
}> = (value) => {
  const resolution = Option.getOrUndefined(resolutionShape(value));
  const memory = resolution && decodeMemory(resolution.memory);
  const review = resolution && decodeReviewItem(resolution.review);
  return memory && review && { memory, review };
};

const searchShape = Schema.decodeUnknownOption(
  Schema.Struct({
    attempt: Schema.Struct({
      data: Schema.Struct({ id: Schema.String, strategy: Schema.Literals(RETRIEVAL_STRATEGIES) }),
      itemType: Schema.Literal("memory-recall-attempt"),
    }),
    results: Schema.Array(
      Schema.Struct({ memory: Schema.Unknown, rank: Schema.Number, score: Schema.Number }),
    ),
    retrievals: Schema.Array(
      Schema.Struct({
        data: Schema.Struct({ id: Schema.String, memoryId: Schema.String }),
        itemType: Schema.Literal("memory-retrieval"),
      }),
    ),
  }),
);

export const decodeSearch: MemoryDecoder<MemorySearchResult> = (value) => {
  const search = Option.getOrUndefined(searchShape(value));
  if (search === undefined) return undefined;
  const retrievalIds = new Map(search.retrievals.map(({ data }) => [data.memoryId, data.id]));
  const hits = decodeEach(
    search.results,
    ({ memory, rank, score }): MemorySearchHit | undefined => {
      const decoded = decodeMemory(memory);
      return decoded && { memory: decoded, rank, retrievalId: retrievalIds.get(decoded.id), score };
    },
  );
  return (
    hits && { attemptId: search.attempt.data.id, hits, strategy: search.attempt.data.strategy }
  );
};

const retrievalRecord = Schema.decodeUnknownOption(
  Schema.Struct({
    data: Schema.Struct({ id: Schema.String, usefulness: Schema.Literals(USEFULNESS_RATINGS) }),
    itemType: Schema.Literal("memory-retrieval"),
  }),
);

export const decodeFeedback: MemoryDecoder<RetrievalFeedback> = (value) =>
  Option.getOrUndefined(
    Option.map(retrievalRecord(value), ({ data }) => ({
      retrievalId: data.id,
      usefulness: data.usefulness,
    })),
  );

const importShape = Schema.decodeUnknownOption(
  Schema.Struct({
    imported: Schema.Array(Schema.Unknown),
    rejected: Schema.Array(Schema.Struct({ index: Schema.Number, reason: Schema.String })),
    replayed: Schema.Array(Schema.Unknown),
  }),
);

export const decodeImport: MemoryDecoder<ImportOutcome> = (value) =>
  Option.getOrUndefined(
    Option.map(importShape(value), ({ imported, rejected, replayed }) => ({
      imported: imported.length,
      rejected,
      replayed: replayed.length,
    })),
  );

const attemptCounts = {
  attempts: Schema.Number,
  completed: Schema.Number,
  failed: Schema.Number,
};

const qualityShape = Schema.decodeUnknownOption(
  Schema.Struct({
    ...attemptCounts,
    canonicalDropRate: Schema.Number,
    duplicateRate: Schema.Number,
    latencyMs: Schema.Struct({
      p50: Schema.optionalKey(Schema.Number),
      p95: Schema.optionalKey(Schema.Number),
      p99: Schema.optionalKey(Schema.Number),
      samples: Schema.Number,
    }),
    retrievals: Schema.Number,
    sampleLimit: Schema.Number,
    strategies: Schema.Record(Schema.String, Schema.Struct(attemptCounts)),
    usefulness: Schema.Struct({
      harmful: Schema.Number,
      neutral: Schema.Number,
      unreviewed: Schema.Number,
      useful: Schema.Number,
    }),
  }),
);

export const decodeQuality: MemoryDecoder<MemoryQuality> = (value) =>
  Option.getOrUndefined(
    Option.map(qualityShape(value), ({ strategies, ...quality }) => ({
      ...quality,
      strategies: Object.entries(strategies).map(([strategy, counts]) => ({ ...counts, strategy })),
    })),
  );
