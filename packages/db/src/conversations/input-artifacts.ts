import {
  AgentInputArtifacts,
  INPUT_ARTIFACT_TYPE,
  INPUT_FILE_PROBLEMS,
  MAX_TOTAL_INPUT_MEDIA_BYTES,
  inputFileProblemCode,
  type InputFileProblemCode,
  type InputFileUnusableReason,
} from "@deployments-ai/agent-manifest";
import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import { key } from "../keys.ts";
import {
  sameArtifactOwner,
  type ArtifactInputFile,
  type ArtifactOwner,
} from "../records/artifacts.ts";
import type { PlatformRecord } from "../records/index.ts";

export type RunInputArtifact = Extract<PlatformRecord, { readonly itemType: "artifact" }>;
export type AdmittedInputFile = Exclude<ArtifactInputFile, { readonly kind: "unusable" }>;
export interface AdmittedRunInputArtifact {
  readonly file: AdmittedInputFile;
  readonly record: RunInputArtifact;
}
export interface RunInputArtifactScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly owner: ArtifactOwner;
}
type RunInputRejection = "input_artifact_unavailable" | "invalid_input_artifacts";
export class RunInputArtifactError extends Error {
  constructor(
    readonly code: InputFileProblemCode | RunInputRejection,
    message: string,
  ) {
    super(message);
    this.name = "RunInputArtifactError";
  }
}

export type RunInputArtifactVerdict =
  | ({ readonly kind: "available" } & AdmittedRunInputArtifact)
  | {
      readonly kind: "unusable";
      readonly reason: InputFileUnusableReason;
      readonly record: RunInputArtifact;
    }
  | { readonly artifactId: string; readonly kind: "rejected"; readonly reason: RunInputRejection };

const REJECTION_MESSAGES = {
  input_artifact_unavailable:
    "Input artifact is unavailable in the caller's private conversation scope.",
  invalid_input_artifacts: 'Input artifacts must be files uploaded with type "input".',
} as const satisfies Record<RunInputRejection, string>;

/** Customer-owned private artifacts only; possession of an ID is never authorization. */
async function inputArtifactVerdict(
  database: DynamoDatabaseService,
  scope: RunInputArtifactScope & { readonly artifactId: string; readonly now: Date },
): Promise<RunInputArtifactVerdict> {
  const { artifactId } = scope;
  const record = await database.getRecord(
    "execution",
    {
      pk: key("ORG", scope.organizationId, "ENV", scope.environmentId),
      sk: key("ARTIFACT", artifactId),
    },
    true,
  );
  if (
    record?.itemType !== "artifact" ||
    record.data.id !== artifactId ||
    record.data.organizationId !== scope.organizationId ||
    record.data.projectId !== scope.projectId ||
    record.data.environmentId !== scope.environmentId ||
    record.data.threadId !== scope.threadId ||
    !sameArtifactOwner(record.data.owner, scope.owner) ||
    record.data.visibility !== "private" ||
    record.data.privateAccess !== undefined ||
    record.data.status !== "available" ||
    (record.data.retentionExpiresAt !== undefined &&
      Date.parse(record.data.retentionExpiresAt) <= scope.now.getTime())
  ) {
    return { artifactId, kind: "rejected", reason: "input_artifact_unavailable" };
  }
  if (record.data.type !== INPUT_ARTIFACT_TYPE) {
    return { artifactId, kind: "rejected", reason: "invalid_input_artifacts" };
  }
  const file = record.data.input;
  if (!file) return { artifactId, kind: "rejected", reason: "input_artifact_unavailable" };
  return file.kind === "unusable"
    ? { kind: "unusable", reason: file.reason, record }
    : { file, kind: "available", record };
}

export async function evaluateRunInputArtifacts(
  database: DynamoDatabaseService,
  input: RunInputArtifactScope & { readonly artifactIds: readonly string[]; readonly now: Date },
): Promise<readonly RunInputArtifactVerdict[]> {
  try {
    Schema.decodeUnknownSync(AgentInputArtifacts)(input.artifactIds);
  } catch {
    throw new RunInputArtifactError(
      "invalid_input_artifacts",
      "Input artifacts must contain one to eight unique canonical IDs.",
    );
  }
  return Promise.all(
    input.artifactIds.map((artifactId) => inputArtifactVerdict(database, { ...input, artifactId })),
  );
}

export function partitionByAggregateLimit(admitted: readonly AdmittedRunInputArtifact[]): {
  readonly kept: readonly AdmittedRunInputArtifact[];
  readonly overflow: readonly AdmittedRunInputArtifact[];
} {
  const kept: AdmittedRunInputArtifact[] = [];
  const overflow: AdmittedRunInputArtifact[] = [];
  let mediaBytes = 0;
  for (const entry of admitted) {
    if (entry.file.kind === "document") {
      kept.push(entry);
      continue;
    }
    mediaBytes += entry.record.data.storage.byteSize;
    (mediaBytes > MAX_TOTAL_INPUT_MEDIA_BYTES ? overflow : kept).push(entry);
  }
  return { kept, overflow };
}

export async function loadRunInputArtifacts(
  database: DynamoDatabaseService,
  input: RunInputArtifactScope & { readonly artifactIds: readonly string[]; readonly now: Date },
): Promise<readonly AdmittedRunInputArtifact[]> {
  const admitted = (await evaluateRunInputArtifacts(database, input)).map((verdict) => {
    switch (verdict.kind) {
      case "available":
        return { file: verdict.file, record: verdict.record };
      case "unusable":
        throw new RunInputArtifactError(
          inputFileProblemCode(verdict.reason),
          `Input file ${verdict.record.data.id} (${verdict.record.data.name}) can't be used: ${INPUT_FILE_PROBLEMS[verdict.reason].copy}`,
        );
      case "rejected":
        throw new RunInputArtifactError(verdict.reason, REJECTION_MESSAGES[verdict.reason]);
      default: {
        const unhandled: never = verdict;
        return unhandled;
      }
    }
  });
  if (partitionByAggregateLimit(admitted).overflow.length > 0) {
    throw new RunInputArtifactError(
      "invalid_input_artifacts",
      `Input images and audio exceed the ${MAX_TOTAL_INPUT_MEDIA_BYTES}-byte aggregate limit.`,
    );
  }
  return admitted;
}

export interface ReadableAttachment {
  readonly file: Extract<AdmittedInputFile, { readonly kind: "document" }>;
  readonly record: RunInputArtifact;
}

const SUBMISSION_SCAN_PAGE_SIZE = 50;
const SUBMISSION_SCAN_PAGES = 8;
const MAX_CHECKED_ATTACHMENTS = 48;
const MAX_LISTED_ATTACHMENTS = 12;

async function submittedInThread(
  database: DynamoDatabaseService,
  scope: RunInputArtifactScope,
  records: readonly RunInputArtifact[],
): Promise<ReadonlySet<string>> {
  const wanted = new Set<string>(records.map(({ data }) => data.id));
  const uploadedAt = Math.min(...records.map(({ data }) => Date.parse(data.createdAt)));
  const submitted = new Set<string>();
  let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
  for (let page = 0; page < SUBMISSION_SCAN_PAGES && submitted.size < wanted.size; page += 1) {
    const result = await database.queryRecords("execution", {
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      ConsistentRead: true,
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: {
        ":pk": key("ORG", scope.organizationId, "THREAD", scope.threadId),
        ":prefix": "MESSAGE#",
      },
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
      Limit: SUBMISSION_SCAN_PAGE_SIZE,
      ScanIndexForward: false,
    });
    for (const message of result.items) {
      if (message.itemType !== "message") continue;
      if (Date.parse(message.data.createdAt) < uploadedAt) return submitted;
      if (message.data.role !== "user") continue;
      for (const artifactId of message.data.inputArtifacts ?? []) {
        if (wanted.has(artifactId)) submitted.add(artifactId);
      }
    }
    exclusiveStartKey = result.lastEvaluatedKey;
    if (!exclusiveStartKey) return submitted;
  }
  return submitted;
}

/**
 * Whether a run may read documents that earlier turns of its thread attached. An email joins its
 * thread through the sender-controlled `References` header, so anyone can reply into one, and an
 * email turn reads only the files its own message attached. A channel thread's audience already saw
 * its files.
 */
function readsEarlierTurns(owner: ArtifactOwner): boolean {
  switch (owner.type) {
    case "principal":
    case "service-account":
      return true;
    case "ingress":
      switch (owner.sourceKind) {
        case "agent-email-binding":
          return false;
        case "channel-binding":
          return true;
        default: {
          const unhandled: never = owner.sourceKind;
          return unhandled;
        }
      }
    default: {
      const unhandled: never = owner;
      return unhandled;
    }
  }
}

export async function loadReadableAttachment(
  database: DynamoDatabaseService,
  input: RunInputArtifactScope & {
    readonly artifactId: string;
    readonly now: Date;
    readonly submitted: readonly string[];
  },
): Promise<ReadableAttachment> {
  const verdict = await inputArtifactVerdict(database, input);
  if (
    verdict.kind === "available" &&
    verdict.file.kind === "document" &&
    (input.submitted.includes(input.artifactId) ||
      (readsEarlierTurns(input.owner) &&
        (await submittedInThread(database, input, [verdict.record])).has(input.artifactId)))
  ) {
    return { file: verdict.file, record: verdict.record };
  }
  throw new RunInputArtifactError(
    "input_artifact_unavailable",
    `Attachment ${input.artifactId} is not a readable document in this conversation.`,
  );
}

export async function listReadableAttachments<Candidate extends { readonly artifactId: string }>(
  database: DynamoDatabaseService,
  input: RunInputArtifactScope & { readonly candidates: readonly Candidate[]; readonly now: Date },
): Promise<readonly (ReadableAttachment & { readonly candidate: Candidate })[]> {
  if (!readsEarlierTurns(input.owner)) return [];
  const documents = (
    await Promise.all(
      input.candidates.slice(0, MAX_CHECKED_ATTACHMENTS).map(async (candidate) => ({
        candidate,
        verdict: await inputArtifactVerdict(database, {
          ...input,
          artifactId: candidate.artifactId,
        }),
      })),
    )
  ).flatMap(({ candidate, verdict }) =>
    verdict.kind === "available" && verdict.file.kind === "document"
      ? [{ candidate, file: verdict.file, record: verdict.record }]
      : [],
  );
  const submitted = await submittedInThread(
    database,
    input,
    documents.map(({ record }) => record),
  );
  return documents
    .filter(({ record }) => submitted.has(record.data.id))
    .slice(0, MAX_LISTED_ATTACHMENTS);
}
