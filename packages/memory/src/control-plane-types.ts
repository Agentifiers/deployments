import type { DynamoDatabaseService, Ulid } from "@deployments-ai/db";
import type { ProvisioningEvidenceEmbedder } from "./control-plane-evidence.ts";
import type { MemorySearchProviderRegistry } from "./provider.ts";

export interface MemorySearchControlPlaneDependencies {
  readonly database: DynamoDatabaseService;
  readonly embedProvisioningEvidence?: ProvisioningEvidenceEmbedder;
  readonly generateId: () => Promise<Ulid>;
  readonly membershipDigest: (targetId: Ulid) => Promise<{
    readonly digest: string;
    readonly keyVersion: number;
  }>;
  readonly membershipDigests?: (targetId: Ulid) => Promise<
    readonly {
      readonly digest: string;
      readonly keyVersion: number;
    }[]
  >;
  readonly now?: () => Date;
  readonly registry?: MemorySearchProviderRegistry;
}

export class MemorySearchControlPlaneError extends Error {
  override readonly name = "MemorySearchControlPlaneError";
}

export type MemorySearchProvisioningStage =
  | "prepare-provider"
  | "read-provider-readiness"
  | "resolve-provider"
  | "verify-evidence";

export class MemorySearchProvisioningStageError extends Error {
  override readonly name = "MemorySearchProvisioningStageError";
  readonly stage: MemorySearchProvisioningStage;

  constructor(stage: MemorySearchProvisioningStage, cause: unknown) {
    super(`Memory search provisioning failed during ${stage}.`, { cause });
    this.stage = stage;
  }
}
