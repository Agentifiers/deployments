import type {
  BrainIndexCanonicalSnapshot,
  BrainIndexPublication,
  BrainIndexStatePort,
} from "@deployments-ai/brains";
import { Schema } from "effect";
import type {
  DatabaseError,
  DynamoDatabaseService,
  TransactionOperation,
} from "../client-types.ts";
import { key } from "../keys.ts";
import { BrainIndexStateRecord } from "../records/brain-search.ts";
import { BrainIndexJobRecord } from "../records/brain-runtime.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import {
  committedBrainProviderMutation,
  type BrainProviderMutationClaim,
} from "./provider-mutation-claim.ts";

type BrainIndexJob = Extract<PlatformRecord, { readonly itemType: "brain-index-job" }>;
type BrainIndexState = Extract<PlatformRecord, { readonly itemType: "brain-index-state" }>;

function condition(
  table: "control" | "execution",
  recordKey: { readonly pk: string; readonly sk: string },
  itemType: string,
  version: number,
  status?: string,
): TransactionOperation {
  return {
    conditionExpression: `#itemType = :itemType AND #data.#version = :version${status ? " AND #data.#status = :status" : ""}`,
    expressionAttributeNames: {
      "#data": "data",
      "#itemType": "itemType",
      ...(status ? { "#status": "status" } : {}),
      "#version": "version",
    },
    expressionAttributeValues: {
      ":itemType": itemType,
      ...(status ? { ":status": status } : {}),
      ":version": version,
    },
    key: recordKey,
    kind: "condition-check",
    table,
  };
}

function placementCondition(job: BrainIndexJob): TransactionOperation {
  return {
    conditionExpression:
      "#itemType = :itemType AND #data.#phase = :phase AND (#data.#generation = :generation OR (#data.#generation = :nextGeneration AND #data.#writeTarget.#targetId = :targetId))",
    expressionAttributeNames: {
      "#data": "data",
      "#generation": "generation",
      "#itemType": "itemType",
      "#phase": "phase",
      "#targetId": "targetId",
      "#writeTarget": "writeTarget",
    },
    expressionAttributeValues: {
      ":generation": job.data.placementGeneration,
      ":itemType": "brain-search-placement",
      ":nextGeneration": job.data.placementGeneration + 1,
      ":phase": "active",
      ":targetId": job.data.targetId,
    },
    key: {
      pk: key("ORG", job.data.organizationId),
      sk: key("BRAIN-SEARCH-PLACEMENT", job.data.organizationId),
    },
    kind: "condition-check",
    table: "control",
  };
}

function documentCondition(snapshot: BrainIndexCanonicalSnapshot): TransactionOperation {
  return {
    conditionExpression:
      "#itemType = :itemType AND #data.#version = :version AND #data.#lifecycle = :lifecycle AND #data.#currentContentVersionId = :currentContentVersionId AND #data.#projectionGeneration = :projectionGeneration",
    expressionAttributeNames: {
      "#currentContentVersionId": "currentContentVersionId",
      "#data": "data",
      "#itemType": "itemType",
      "#lifecycle": "lifecycle",
      "#projectionGeneration": "projectionGeneration",
      "#version": "version",
    },
    expressionAttributeValues: {
      ":currentContentVersionId": snapshot.version.id,
      ":itemType": "brain-document",
      ":lifecycle": "active",
      ":projectionGeneration": snapshot.document.projectionGeneration,
      ":version": snapshot.document.version,
    },
    key: {
      pk: key("ORG", snapshot.document.organizationId, "BRAIN", snapshot.document.brainId),
      sk: key("BRAIN-DOCUMENT", snapshot.document.id),
    },
    kind: "condition-check",
    table: "control",
  };
}

function stateRecord(input: {
  readonly job: BrainIndexJob;
  readonly now: string;
  readonly previous?: BrainIndexState;
  readonly publication: BrainIndexPublication;
  readonly snapshot: BrainIndexCanonicalSnapshot;
  readonly status: "failed" | "ready";
}) {
  const componentResult = new Map(
    input.publication.components.map((component) => [component.kind, component]),
  );
  return Schema.decodeUnknownSync(BrainIndexStateRecord)(
    withCanonicalRecordKeys({
      data: {
        attemptId: input.job.data.id,
        brainId: input.job.data.brainId,
        chunkIds: input.publication.chunkIds,
        components: input.job.data.components.map((component) => {
          const result = componentResult.get(component.kind);
          return {
            componentId: component.componentId,
            ...(result?.error ? { error: result.error } : {}),
            kind: component.kind,
            status: result?.ready ? ("ready" as const) : ("failed" as const),
            updatedAt: input.now,
          };
        }),
        contentHash: input.publication.contentHash,
        createdAt: input.previous?.data.createdAt ?? input.now,
        documentId: input.job.data.documentId,
        documentVersionId: input.job.data.documentVersionId,
        embeddingProfileId: input.job.data.embeddingProfileId,
        ...(input.status === "failed"
          ? { lastError: "One or more Brain search components are incomplete." }
          : {}),
        organizationId: input.job.data.organizationId,
        placementGeneration: input.job.data.placementGeneration,
        projectionGeneration: input.job.data.expectedProjectionGeneration,
        provider: input.job.data.provider,
        schemaGeneration: input.job.data.schemaGeneration,
        sourceId: input.job.data.sourceId,
        status: input.status,
        ...(input.status === "ready" ? { synchronizedAt: input.now } : {}),
        targetId: input.job.data.targetId,
        updatedAt: input.now,
        version: input.previous ? input.previous.data.version + 1 : 0,
      },
      itemType: "brain-index-state" as const,
    }),
  );
}

async function previousState(database: DynamoDatabaseService, job: BrainIndexJob) {
  const value = await database.getRecord(
    "control",
    {
      pk: key("ORG", job.data.organizationId, "DOCUMENT", job.data.documentId),
      sk: key("BRAIN-INDEX-STATE", job.data.documentId),
    },
    true,
  );
  return value?.itemType === "brain-index-state" ? value : undefined;
}

export function makeBrainIndexStatePort(input: {
  readonly database: DynamoDatabaseService;
  readonly job: BrainIndexJob;
  readonly mutationClaim?: BrainProviderMutationClaim;
  readonly now: () => string;
  readonly snapshot: BrainIndexCanonicalSnapshot;
}): BrainIndexStatePort {
  const baseConditions = (checkJob: boolean): TransactionOperation[] => [
    condition(
      "control",
      {
        pk: key("ORG", input.snapshot.brain.organizationId),
        sk: key("BRAIN", input.snapshot.brain.id),
      },
      "brain",
      input.snapshot.brain.version,
      "active",
    ),
    condition(
      "control",
      {
        pk: key(
          "ORG",
          input.snapshot.source.organizationId,
          "BRAIN",
          input.snapshot.source.brainId,
        ),
        sk: key("BRAIN-SOURCE", input.snapshot.source.id),
      },
      "brain-source",
      input.snapshot.source.version,
      "active",
    ),
    documentCondition(input.snapshot),
    placementCondition(input.job),
    ...(checkJob
      ? [
          condition(
            "execution",
            { pk: input.job.pk, sk: input.job.sk },
            "brain-index-job",
            input.job.data.version,
            "running",
          ),
        ]
      : []),
  ];
  return {
    async publishReady(publication) {
      const previous = await previousState(input.database, input.job);
      const timestamp = input.now();
      const state = stateRecord({
        job: input.job,
        now: timestamp,
        ...(previous ? { previous } : {}),
        publication,
        snapshot: input.snapshot,
        status: "ready",
      });
      const terminalJob = Schema.decodeUnknownSync(BrainIndexJobRecord)(
        withCanonicalRecordKeys({
          ...input.job,
          data: {
            ...input.job.data,
            completedAt: timestamp,
            status: "succeeded" as const,
            updatedAt: timestamp,
            version: input.job.data.version + 1,
          },
        }),
      );
      const committedClaim = input.mutationClaim
        ? committedBrainProviderMutation(input.mutationClaim, timestamp)
        : undefined;
      try {
        await input.database.transactWrite([
          ...baseConditions(false),
          {
            kind: "put",
            ...(previous ? { previousRecord: previous } : {}),
            record: state,
          },
          { kind: "put", previousRecord: input.job, record: terminalJob },
          ...(committedClaim
            ? [
                {
                  kind: "put" as const,
                  previousRecord: input.mutationClaim!,
                  record: committedClaim,
                },
              ]
            : []),
        ]);
        return true;
      } catch (cause) {
        return (cause as DatabaseError).reason === "conflict" ? false : Promise.reject(cause);
      }
    },
    async recordIncomplete(publication) {
      const previous = await previousState(input.database, input.job);
      const state = stateRecord({
        job: input.job,
        now: input.now(),
        ...(previous ? { previous } : {}),
        publication,
        snapshot: input.snapshot,
        status: "failed",
      });
      await input.database.transactWrite([
        ...baseConditions(true),
        {
          kind: "put",
          ...(previous ? { previousRecord: previous } : {}),
          record: state,
        },
      ]);
    },
  };
}
