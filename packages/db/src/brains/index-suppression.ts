import type { BrainDocument } from "@deployments-ai/brains";
import { Schema } from "effect";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import { key } from "../keys.ts";
import { BrainIndexStateRecord } from "../records/brain-search.ts";
import { BrainIndexJobRecord } from "../records/brain-runtime.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import type { BrainIndexJob } from "./index-job-lifecycle.ts";
import {
  committedBrainProviderMutation,
  type BrainProviderMutationClaim,
} from "./provider-mutation-claim.ts";

type BrainIndexState = Extract<PlatformRecord, { readonly itemType: "brain-index-state" }>;

export async function getBrainIndexState(
  database: DynamoDatabaseService,
  organizationId: string,
  documentId: string,
) {
  const value = await database.getRecord(
    "control",
    {
      pk: key("ORG", organizationId, "DOCUMENT", documentId),
      sk: key("BRAIN-INDEX-STATE", documentId),
    },
    true,
  );
  return value?.itemType === "brain-index-state" ? value : undefined;
}

function condition(
  table: "control" | "execution",
  recordKey: { readonly pk: string; readonly sk: string },
  expression: string,
  names: Readonly<Record<string, string>>,
  values: Readonly<Record<string, unknown>>,
): TransactionOperation {
  return {
    conditionExpression: expression,
    expressionAttributeNames: names,
    expressionAttributeValues: values,
    key: recordKey,
    kind: "condition-check",
    table,
  };
}

export async function completeBrainIndexSuppression(input: {
  readonly claim: BrainProviderMutationClaim;
  readonly database: DynamoDatabaseService;
  readonly document: BrainDocument;
  readonly job: BrainIndexJob;
  readonly now: string;
  readonly previousState?: BrainIndexState;
}) {
  if (
    input.job.data.status !== "running" ||
    input.job.data.operation !== "suppress" ||
    input.document.lifecycle === "active" ||
    input.document.projectionGeneration !== input.job.data.expectedProjectionGeneration ||
    input.document.currentVersionId !== input.job.data.documentVersionId
  ) {
    throw new TypeError("Brain suppression no longer matches canonical document state.");
  }
  const state = Schema.decodeUnknownSync(BrainIndexStateRecord)(
    withCanonicalRecordKeys({
      data: {
        attemptId: input.job.data.id,
        brainId: input.job.data.brainId,
        chunkIds: [],
        components: input.job.data.components.map((component) => ({
          componentId: component.componentId,
          kind: component.kind,
          status: "suppressed" as const,
          updatedAt: input.now,
        })),
        createdAt: input.previousState?.data.createdAt ?? input.now,
        documentId: input.job.data.documentId,
        documentVersionId: input.job.data.documentVersionId,
        embeddingProfileId: input.job.data.embeddingProfileId,
        organizationId: input.job.data.organizationId,
        placementGeneration: input.job.data.placementGeneration,
        projectionGeneration: input.job.data.expectedProjectionGeneration,
        provider: input.job.data.provider,
        schemaGeneration: input.job.data.schemaGeneration,
        sourceId: input.job.data.sourceId,
        status: "suppressed" as const,
        synchronizedAt: input.now,
        targetId: input.job.data.targetId,
        updatedAt: input.now,
        version: input.previousState ? input.previousState.data.version + 1 : 0,
      },
      itemType: "brain-index-state" as const,
    }),
  );
  const terminalJob = Schema.decodeUnknownSync(BrainIndexJobRecord)(
    withCanonicalRecordKeys({
      ...input.job,
      data: {
        ...input.job.data,
        completedAt: input.now,
        components: input.job.data.components.map((component) => ({
          ...component,
          status: "suppressed" as const,
        })),
        status: "succeeded" as const,
        updatedAt: input.now,
        version: input.job.data.version + 1,
      },
    }),
  );
  const committedClaim = committedBrainProviderMutation(input.claim, input.now);
  await input.database.transactWrite([
    condition(
      "control",
      {
        pk: key("ORG", input.document.organizationId, "BRAIN", input.document.brainId),
        sk: key("BRAIN-DOCUMENT", input.document.id),
      },
      "#itemType = :itemType AND #data.#version = :version AND #data.#projectionGeneration = :generation AND #data.#currentVersionId = :versionId AND #data.#lifecycle <> :active",
      {
        "#currentVersionId": "currentVersionId",
        "#data": "data",
        "#itemType": "itemType",
        "#lifecycle": "lifecycle",
        "#projectionGeneration": "projectionGeneration",
        "#version": "version",
      },
      {
        ":active": "active",
        ":generation": input.document.projectionGeneration,
        ":itemType": "brain-document",
        ":version": input.document.version,
        ":versionId": input.document.currentVersionId,
      },
    ),
    condition(
      "control",
      {
        pk: key("ORG", input.job.data.organizationId),
        sk: key("BRAIN-SEARCH-PLACEMENT", input.job.data.organizationId),
      },
      "#itemType = :itemType AND #data.#phase = :phase AND (#data.#generation = :generation OR (#data.#generation = :nextGeneration AND #data.#writeTarget.#targetId = :targetId))",
      {
        "#data": "data",
        "#generation": "generation",
        "#itemType": "itemType",
        "#phase": "phase",
        "#targetId": "targetId",
        "#writeTarget": "writeTarget",
      },
      {
        ":generation": input.job.data.placementGeneration,
        ":itemType": "brain-search-placement",
        ":nextGeneration": input.job.data.placementGeneration + 1,
        ":phase": "active",
        ":targetId": input.job.data.targetId,
      },
    ),
    {
      kind: "put",
      ...(input.previousState ? { previousRecord: input.previousState } : {}),
      record: state,
    },
    { kind: "put", previousRecord: input.job, record: terminalJob },
    { kind: "put", previousRecord: input.claim, record: committedClaim },
  ]);
  return state;
}
