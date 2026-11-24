import {
  makeEvaluationPersistence,
  makeModelIdAdmission,
  MessageRecord,
  RunLookupRecord,
  RunRecord,
  runLocatorRecord,
  TraceRecord,
  withCanonicalRecordKeys,
  type EvaluationPersistence,
  type IdempotencyExecution,
  Ulid,
  type IdempotencyPersistence,
  type PlatformRecord,
  type DynamoDatabaseService,
} from "@deployments-ai/db";
import { evaluationMemoryDatabase } from "@deployments-ai/db/evaluation-testing";
import {
  evaluationQueueEnvelope,
  type EvaluationQueueEnvelope,
  type EvaluationQueueMessage,
} from "@deployments-ai/observability/evaluators";
import { Schema } from "effect";
import type { ApiIdentity } from "../api-service-contracts.ts";
import { createEvaluationApi } from "./api.ts";
import { makeEvaluationApiService } from "./service.ts";
import type {
  EvaluationArtifactStore,
  EvaluationBlobReference,
  EvaluationEnvironment,
} from "./service-contracts.ts";

const id = (suffix: string) => `01ARZ3NDEKTSV4RRFFQ69G5F${suffix}`;

export const ORG = id("00");
export const PROJECT = id("01");
export const ENV = id("02");
export const OTHER_ENV = id("03");
export const PRINCIPAL = id("04");
export const BASELINE_RELEASE = id("05");
export const CANDIDATE_RELEASE = id("06");
const DEPLOYMENT = id("07");
export const SESSION = id("08");
export const ROOT_RUN = id("09");
const USER_MESSAGE = id("10");
const AGENT_DEFINITION = id("11");
export const FINALIZED_TRACE = "0123456789abcdef0123456789abcdef";
export const OPEN_TRACE = "fedcba9876543210fedcba9876543210";
export const NOW = "2026-09-29T12:00:00.000Z";
export const RUN_INPUT = "What is the refund policy for annual plans?";

const decodeUlid = Schema.decodeUnknownSync(Ulid);
const scope = {
  environmentId: decodeUlid(ENV),
  organizationId: decodeUlid(ORG),
  projectId: decodeUlid(PROJECT),
};

export const writerIdentity: ApiIdentity = {
  authentication: "tenant-jwt",
  environmentIds: [ENV],
  organizationIds: [ORG],
  principalId: PRINCIPAL,
  projectIds: [PROJECT],
  scopes: ["observability:read", "observability:write"],
};

function traceRecord(traceId: string, status: "finalized" | "open") {
  return Schema.decodeUnknownSync(TraceRecord)(
    withCanonicalRecordKeys({
      data: {
        ...scope,
        captureMode: "full-content",
        createdAt: NOW,
        ...(status === "finalized" ? { finalizedAt: NOW } : {}),
        id: traceId,
        redactionPolicyVersion: 1,
        rootRunId: ROOT_RUN,
        rootSpanId: "0123456789abcdef",
        runIds: [ROOT_RUN],
        schemaVersion: 1,
        sessionId: SESSION,
        status,
        traceId,
        updatedAt: NOW,
        version: 1,
      },
      itemType: "trace",
    }),
  ) as PlatformRecord;
}

/**
 * Agent releases carry a validated manifest the evaluation API never reads; the fixture
 * stores only the fields the evaluation facades use (scope, id, content hash).
 */
function agentReleaseRecord(releaseId: string, contentHash: string) {
  return withCanonicalRecordKeys({
    data: {
      ...scope,
      agentDefinitionId: AGENT_DEFINITION,
      contentHash,
      createdAt: NOW,
      createdByPrincipalId: PRINCIPAL,
      id: releaseId,
      releaseNumber: 1,
      status: "active",
      version: 0,
    },
    itemType: "agent-release",
  }) as unknown as PlatformRecord;
}

function runRecords(): PlatformRecord[] {
  const run = Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...scope,
        agentDeploymentId: DEPLOYMENT,
        agentReleaseId: BASELINE_RELEASE,
        attempt: 0,
        captureMode: "full-content",
        createdAt: NOW,
        executor: "hosted",
        id: ROOT_RUN,
        idempotencyKey: "customer-run-1",
        priority: 0,
        redactionPolicyVersion: 1,
        schemaVersion: 1,
        spanId: "0123456789abcdef",
        status: "completed",
        threadId: SESSION,
        traceId: FINALIZED_TRACE,
        trigger: "api",
        updatedAt: NOW,
        userMessageId: USER_MESSAGE,
        userMessageSequence: 1,
        version: 1,
      },
      itemType: "run",
    }),
  );
  const lookup = Schema.decodeUnknownSync(RunLookupRecord)(
    withCanonicalRecordKeys({
      data: {
        ...scope,
        createdAt: NOW,
        idempotencyKey: "customer-run-1",
        runId: ROOT_RUN,
        threadId: SESSION,
      },
      itemType: "run-lookup",
    }),
  );
  const message = Schema.decodeUnknownSync(MessageRecord)(
    withCanonicalRecordKeys({
      data: {
        ...scope,
        body: RUN_INPUT,
        contentHash: "input-hash",
        createdAt: NOW,
        id: USER_MESSAGE,
        role: "user",
        runId: ROOT_RUN,
        sequence: 1,
        threadId: SESSION,
      },
      itemType: "message",
    }),
  );
  return [run, runLocatorRecord(run)!, lookup, message] as PlatformRecord[];
}

interface MemoryArtifacts {
  readonly downloads: EvaluationBlobReference[];
  readonly objects: Map<string, Uint8Array>;
  readonly store: EvaluationArtifactStore;
}

function memoryArtifacts(): MemoryArtifacts {
  const objects = new Map<string, Uint8Array>();
  const downloads: EvaluationBlobReference[] = [];
  const store: EvaluationArtifactStore = {
    async putCaseMaterial(input) {
      const key = `organizations/${input.organizationId}/evaluation-cases/${input.datasetId}/${input.contentSha256}.json`;
      objects.set(key, input.bytes);
      return {
        bucket: "artifacts",
        byteSize: input.bytes.byteLength,
        contentType: "application/json",
        key,
        sha256: input.contentSha256,
        versionId: "version-1",
      };
    },
    async readText(reference) {
      const bytes = objects.get(reference.key);
      if (!bytes) throw new Error(`Missing artifact ${reference.key}.`);
      return new TextDecoder().decode(bytes);
    },
    async createDownloadUrl(reference) {
      downloads.push(reference);
      return {
        downloadUrl: `https://downloads.example/${reference.key}`,
        downloadUrlExpiresAt: "2026-09-29T12:05:00.000Z",
      };
    },
  };
  return { downloads, objects, store };
}

/** Replays a completed operation for the same key, like the DynamoDB idempotency store. */
function memoryIdempotency(): IdempotencyPersistence {
  const completed = new Map<string, { readonly fingerprint: string; readonly value: unknown }>();
  return {
    async execute(input: IdempotencyExecution) {
      const cacheKey = `${input.principalId}\u0000${input.key}`;
      const previous = completed.get(cacheKey);
      if (previous) {
        if (previous.fingerprint !== input.fingerprint) {
          throw Object.assign(new Error("Idempotency-Key reused with a different request."), {
            code: "idempotency_conflict",
            status: 409,
          });
        }
        return previous.value;
      }
      const value = await input.operation();
      completed.set(cacheKey, { fingerprint: input.fingerprint, value });
      return value;
    },
  };
}

interface SentEvaluationMessage {
  readonly envelope: EvaluationQueueEnvelope;
  readonly message: EvaluationQueueMessage;
}

interface EvaluationCallInit {
  readonly body?: unknown;
  readonly environmentId?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Defaults to a key derived from the request; null omits the header. */
  readonly idempotencyKey?: string | null;
}

interface EvaluationCallResult {
  readonly body: Record<string, any>;
  readonly status: number;
}

export interface EvaluationHarness {
  readonly artifacts: MemoryArtifacts;
  readonly call: (
    method: "GET" | "POST",
    path: string,
    init?: EvaluationCallInit,
  ) => Promise<EvaluationCallResult>;
  readonly persistence: EvaluationPersistence;
  readonly sent: readonly SentEvaluationMessage[];
}

export interface EvaluationHarnessOptions {
  readonly database?: DynamoDatabaseService;
  readonly environment?: EvaluationEnvironment;
  readonly identity?: ApiIdentity | null;
  readonly idempotency?: IdempotencyPersistence;
  readonly queue?: boolean;
  readonly records?: readonly PlatformRecord[];
}

export function evaluationHarness(options: EvaluationHarnessOptions = {}): EvaluationHarness {
  const database =
    options.database ??
    evaluationMemoryDatabase([
      traceRecord(FINALIZED_TRACE, "finalized"),
      traceRecord(OPEN_TRACE, "open"),
      agentReleaseRecord(BASELINE_RELEASE, "baseline-content-hash"),
      agentReleaseRecord(CANDIDATE_RELEASE, "candidate-content-hash"),
      ...runRecords(),
      ...(options.records ?? []),
    ]).database;
  const artifacts = memoryArtifacts();
  const sent: SentEvaluationMessage[] = [];
  let sequence = 0;
  const fetch = createEvaluationApi({
    authenticate: async (request) =>
      request.headers.get("authorization")?.startsWith("Bearer ")
        ? options.identity === undefined
          ? writerIdentity
          : options.identity
        : null,
    idempotency: options.idempotency ?? memoryIdempotency(),
    requestId: () => "request-test",
    resolveEnvironment: async (input) =>
      options.environment ??
      (input.environmentId === ENV || input.environmentId === OTHER_ENV
        ? {
            id: input.environmentId,
            organizationId: ORG,
            projectId: PROJECT,
            status: "active",
          }
        : undefined),
    service: makeEvaluationApiService({
      admitJudgeModel: makeModelIdAdmission(database),
      artifacts: artifacts.store,
      generateId: async () => {
        sequence += 1;
        return `01J${String(sequence).padStart(23, "0")}`;
      },
      now: () => NOW,
      persistence: (evaluationScope) => makeEvaluationPersistence(database, evaluationScope),
      ...(options.queue === false
        ? {}
        : {
            queue: {
              send: async (message: EvaluationQueueMessage) => {
                sent.push({ envelope: evaluationQueueEnvelope(message), message });
              },
            },
          }),
    }),
  });

  async function call(method: "GET" | "POST", path: string, init: EvaluationCallInit = {}) {
    const headers: Record<string, string> = {
      authorization: "Bearer token",
      "content-type": "application/json",
      "x-deployments-environment": init.environmentId ?? ENV,
      "x-deployments-organization": ORG,
      "x-deployments-project": PROJECT,
      ...init.headers,
    };
    if (method === "POST" && init.idempotencyKey !== null) {
      headers["idempotency-key"] =
        init.idempotencyKey ?? `key-${path}-${JSON.stringify(init.body)}`;
    }
    const response = await fetch(
      new Request(`https://api.example${path}`, {
        headers,
        method,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    );
    if (!response) throw new Error(`No evaluation route matched ${method} ${path}.`);
    return { body: (await response.json()) as Record<string, any>, status: response.status };
  }

  return {
    artifacts,
    call,
    persistence: makeEvaluationPersistence(database, scope),
    sent,
  };
}
