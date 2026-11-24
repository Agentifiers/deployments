import type { BrainApiRouteName } from "@deployments-ai/api-contract";
import type { Brain, BrainQueryRuntime, BrainRepository } from "@deployments-ai/brains";
import type { DynamoDatabaseService } from "@deployments-ai/db";
import type { ApiIdentity } from "../api-service-contracts.ts";
import type { BrainContentUploader } from "./content-upload.ts";

export interface BrainApiInvocation {
  readonly body: unknown;
  readonly identity: ApiIdentity;
  readonly idempotencyKey?: string;
  readonly organizationId: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: {
    readonly cursor?: string;
    readonly limit?: number;
    readonly status?: Brain["status"];
  };
  readonly rawRequest?: Request;
}

export interface BrainApiService {
  readonly invoke: (
    routeName: BrainApiRouteName,
    invocation: BrainApiInvocation,
  ) => Promise<unknown>;
}

export interface BrainApiServiceDependencies {
  readonly brainQueryRuntime?: BrainQueryRuntime;
  readonly contentBucket?: string;
  readonly contentKmsKeyArn?: string;
  readonly contentUploader?: BrainContentUploader;
  readonly database: DynamoDatabaseService;
  readonly generateId: () => Promise<string>;
  readonly now?: () => string;
  readonly repository: BrainRepository;
}
