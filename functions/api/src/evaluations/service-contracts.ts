import type { EvaluationApiRouteName } from "@deployments-ai/api-contract";
import type {
  AdmitModelId,
  DatasetCaseRecord,
  EvaluationPersistence,
  EvaluationScope,
} from "@deployments-ai/db";
import type { EvaluationQueueMessage } from "@deployments-ai/observability/evaluators";
import type { ApiIdentity } from "../api-service-contracts.ts";

export type EvaluationBlobReference = DatasetCaseRecord["data"]["material"];

export interface EvaluationApiInvocation {
  readonly body: unknown;
  readonly identity: ApiIdentity;
  readonly idempotencyKey?: string;
  readonly params: Readonly<Record<string, string>>;
  /** The route's declared query parameters, validated against their contract schemas. */
  readonly query: {
    readonly agentReleaseId?: string;
    readonly baselineReleaseId?: string;
    readonly candidateReleaseId?: string;
    readonly cursor?: string;
    readonly datasetId?: string;
    readonly limit?: number;
    readonly scoreDefinitionId?: string;
    /** One of the route's contract `status` enum values. */
    readonly status?: string;
  };
  readonly scope: EvaluationScope;
}

export interface EvaluationApiService {
  readonly invoke: (
    routeName: EvaluationApiRouteName,
    invocation: EvaluationApiInvocation,
  ) => Promise<unknown>;
}

export interface EvaluationReportDownload {
  readonly downloadUrl: string;
  readonly downloadUrlExpiresAt: string;
}

/** Immutable artifact-bucket storage for case material, input capture, and comparison reports. */
export interface EvaluationArtifactStore {
  readonly putCaseMaterial: (input: {
    readonly bytes: Uint8Array;
    readonly contentSha256: string;
    readonly datasetId: string;
    readonly organizationId: string;
  }) => Promise<EvaluationBlobReference>;
  /** Reads a bounded UTF-8 object (e.g. an externally stored message body). */
  readonly readText: (reference: EvaluationBlobReference, maximumBytes: number) => Promise<string>;
  readonly createDownloadUrl: (
    reference: EvaluationBlobReference,
  ) => Promise<EvaluationReportDownload>;
}

export interface EvaluationQueue {
  readonly send: (message: EvaluationQueueMessage) => Promise<void>;
}

export interface EvaluationApiServiceDependencies {
  /** Admits a model-judge model against the environment's model policy, the catalog, and grants. */
  readonly admitJudgeModel: AdmitModelId;
  readonly artifacts: EvaluationArtifactStore;
  readonly generateId: () => Promise<string>;
  readonly now?: () => string;
  readonly persistence: (scope: EvaluationScope) => EvaluationPersistence;
  /** Absent when no evaluation queue is configured; mutations that must enqueue answer 503. */
  readonly queue?: EvaluationQueue;
}

export interface EvaluationEnvironment {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly status: string;
}

/** Confirms the requested environment; returns undefined when it does not exist. */
export type EvaluationEnvironmentResolver = (input: {
  readonly environmentId: string;
  readonly identity: ApiIdentity;
  readonly organizationId: string;
  readonly projectId: string;
}) => Promise<EvaluationEnvironment | undefined>;
