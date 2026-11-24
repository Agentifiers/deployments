import type { DynamoDatabaseService, IdGeneratorService } from "@deployments-ai/db";
import {
  makeSandboxManager as makeConfiguredSandboxManager,
  type SandboxManagerConfig,
  type SandboxProvider,
} from "./index.ts";

export const TEST_ORGANIZATION_SANDBOX_LIMIT = 16;

export function makeSandboxManager(
  provider: SandboxProvider,
  database: DynamoDatabaseService,
  ids: IdGeneratorService,
  config: Partial<SandboxManagerConfig> = {},
) {
  return makeConfiguredSandboxManager(provider, database, ids, {
    onSandboxCapacityRejected: () => {},
    onStaleCapacityRecovered: () => {},
    organizationSandboxLimit: async () => TEST_ORGANIZATION_SANDBOX_LIMIT,
    ...config,
  });
}
