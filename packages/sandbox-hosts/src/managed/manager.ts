import type { DynamoDatabaseService, IdGeneratorService } from "@deployments-ai/db";
import { Effect } from "effect";
import type { SandboxProvider } from "../types.ts";
import { createAllocationRuntime } from "./allocation.ts";
import { createCapacityRuntime } from "./capacity.ts";
import { createCompensationRuntime } from "./compensation.ts";
import { createCreateReconciliationRuntime } from "./create-reconciliation.ts";
import type { ManagerBase, SandboxManagerConfig, SandboxManagerService } from "./contracts.ts";
import { createLifecycleReconciliationRuntime } from "./lifecycle-reconciliation.ts";
import { createLifecycleMethods } from "./lifecycle.ts";
import { createOperationRuntime } from "./operations.ts";
import { createStateRuntime } from "./state.ts";
import { createTransitionRuntime } from "./transitions.ts";

const MAX_SANDBOX_USAGE_RATE_USD_MICROS = 1_000_000_000;
const DEFAULT_SANDBOX_OPERATION_ACQUIRE_TIMEOUT_MS = 60_000;
const DEFAULT_SANDBOX_OPERATION_LEASE_MS = 15 * 60 * 1_000;
const MIN_SANDBOX_OPERATION_LEASE_MS = 3_000;

export function makeSandboxManager(
  provider: SandboxProvider,
  database: DynamoDatabaseService,
  ids: IdGeneratorService,
  config: SandboxManagerConfig,
): SandboxManagerService {
  for (const [name, rate] of Object.entries(config.costPolicy ?? {})) {
    if (
      !Number.isSafeInteger(rate) ||
      (rate as number) < 0 ||
      (rate as number) > MAX_SANDBOX_USAGE_RATE_USD_MICROS
    ) {
      throw new Error(
        `Sandbox costPolicy.${name} must be a non-negative safe integer no greater than ${MAX_SANDBOX_USAGE_RATE_USD_MICROS}.`,
      );
    }
  }

  const operationAcquireTimeoutMs =
    config.operationAcquireTimeoutMs ?? DEFAULT_SANDBOX_OPERATION_ACQUIRE_TIMEOUT_MS;
  if (!Number.isSafeInteger(operationAcquireTimeoutMs) || operationAcquireTimeoutMs < 0) {
    throw new Error("Sandbox operationAcquireTimeoutMs must be a non-negative safe integer.");
  }

  const operationLeaseMs = config.operationLeaseMs ?? DEFAULT_SANDBOX_OPERATION_LEASE_MS;
  if (
    !Number.isSafeInteger(operationLeaseMs) ||
    operationLeaseMs < MIN_SANDBOX_OPERATION_LEASE_MS
  ) {
    throw new Error(
      `Sandbox operationLeaseMs must be a safe integer of at least ${MIN_SANDBOX_OPERATION_LEASE_MS}.`,
    );
  }

  const base: ManagerBase = {
    config,
    database,
    ids,
    now: config.now ?? Date.now,
    operationAcquireTimeoutMs,
    operationLeaseMs,
    operationLeaseNow: config.operationLeaseNow ?? Date.now,
    provider,
    providerMutationSignals: new WeakSet<AbortSignal>(),
  };
  const transitions = createTransitionRuntime(base);
  const operations = createOperationRuntime(base);
  const state = createStateRuntime(base);
  const capacity = createCapacityRuntime({
    ...base,
    ...transitions,
    destroy: (sandbox) => Effect.suspend(() => service.destroy(sandbox)),
  });
  const core = { ...base, ...transitions, ...operations, ...state, ...capacity };
  const compensation = createCompensationRuntime(core);
  const allocation = createAllocationRuntime({ ...core, ...compensation });
  const createReconciliation = createCreateReconciliationRuntime({
    ...core,
    ...allocation,
  });
  const lifecycleReconciliation = createLifecycleReconciliationRuntime(core);

  const service = createLifecycleMethods({
    ...core,
    ...compensation,
    ...allocation,
    ...createReconciliation,
    ...lifecycleReconciliation,
  });
  return service;
}
