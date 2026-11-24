import { Schema } from "effect";
import type { DynamoDatabaseService, TransactionPut } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import {
  GenerationReasoningRecord,
  type GenerationReasoningDetails,
} from "../records/generation-reasoning.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";

export type GenerationReasoningRecordValue = Extract<
  PlatformRecord,
  { readonly itemType: "generation-reasoning" }
>;

export interface GenerationReasoningRunScope {
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly runId: Ulid;
  readonly threadId: Ulid;
}

export interface GenerationReasoningCreateInput {
  readonly createdAt: string;
  readonly modelCallIndex: number;
  readonly producerAttemptId: string;
  readonly producerModelId: string;
  readonly reasoningDetails: GenerationReasoningDetails;
  readonly scope: GenerationReasoningRunScope;
}

export function generationReasoningCreateOperation(
  input: GenerationReasoningCreateInput,
): TransactionPut {
  const { scope, ...fields } = input;
  return {
    conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    kind: "put",
    record: Schema.decodeUnknownSync(GenerationReasoningRecord)(
      withCanonicalRecordKeys({
        data: { ...scope, ...fields },
        itemType: "generation-reasoning" as const,
      }),
    ),
  };
}

function inRunScope(
  data: GenerationReasoningRecordValue["data"],
  scope: GenerationReasoningRunScope,
) {
  return (
    data.environmentId === scope.environmentId &&
    data.organizationId === scope.organizationId &&
    data.projectId === scope.projectId &&
    data.runId === scope.runId &&
    data.threadId === scope.threadId
  );
}

export async function listRunGenerationReasoning(
  database: DynamoDatabaseService,
  scope: GenerationReasoningRunScope,
  signal?: AbortSignal,
): Promise<readonly GenerationReasoningRecordValue[]> {
  const records: GenerationReasoningRecordValue[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await database.queryRecords(
      "execution",
      {
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        ConsistentRead: true,
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: {
          ":pk": key("ORG", scope.organizationId, "RUN", scope.runId),
          ":prefix": "GENERATION-REASONING#",
        },
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
      },
      signal,
    );
    for (const record of page.items) {
      if (record.itemType !== "generation-reasoning" || !inRunScope(record.data, scope)) {
        throw new Error(`Run ${scope.runId} stores generation reasoning outside its scope.`);
      }
      records.push(record);
    }
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey);
  return records;
}
