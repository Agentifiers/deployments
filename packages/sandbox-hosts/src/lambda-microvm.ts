import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  ResumeMicrovmCommand,
  RunMicrovmCommand,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
  type RunMicrovmRequest,
} from "@aws-sdk/client-lambda-microvms";
import {
  lambdaControlPath,
  lambdaMicrovmImageRef,
  readLambdaRecord,
  readLambdaString,
  readMicrovmEndpoint,
  readMicrovmId,
  readMicrovmState,
  sleep,
} from "./lambda-microvm/wire.ts";
import {
  type CheckpointReconciliation,
  type LambdaMicrovmProviderConfig,
  SandboxAllocationCleanupError,
  SandboxAllocationLeaseError,
  SandboxAllocationUnknownError,
  SandboxCheckpointUnknownError,
  SandboxDataPlaneUnknownError,
  SandboxDestroyUnknownError,
  SandboxResumeUnknownError,
  type SandboxLease,
  type SandboxProvider,
  readExecResponse,
} from "./types.ts";
import { readErrorBody, readSandboxJsonResponse } from "./bounded-response.ts";
import {
  LambdaMicrovmControlResponseError,
  isDeterministicClientError,
  isResourceNotFound,
  isStateConflict,
  lambdaControlMutationOutcomeIsDeterministic,
  lambdaIsolatedExecRefusal,
  requestSignal,
  readRunTiming,
  resolveLambdaMicrovmProviderConfig,
} from "./lambda-microvm/config.ts";

export function createLambdaMicrovmProvider(config: LambdaMicrovmProviderConfig): SandboxProvider {
  const {
    allocationFingerprint,
    allocationReconciliationAttempts,
    authTokenRefreshMarginMs,
    authTokenTtlMinutes,
    client,
    controlPathPrefix,
    controlPort,
    effectiveRegion,
    fetchImpl,
    fingerprintFor,
    imageMemoryMiB,
    imageVcpu,
    now,
    providerRouteKey,
    readinessIntervalMs,
    readinessPath,
    readinessTimeoutMs,
    reconciliationTarget,
    requestTimeoutMs,
    runInputFor,
    suspensionIntervalMs,
    suspensionTimeoutMs,
  } = resolveLambdaMicrovmProviderConfig(config);

  function assertProviderRoute(lease: SandboxLease) {
    if (lease.providerRouteKey && lease.providerRouteKey !== providerRouteKey) {
      throw new Error("Lambda MicroVM lease belongs to a different provider route");
    }
  }
  const endpointCache = new Map<string, string>();
  const authTokenCache = new Map<string, { expiresAt: number; headers: Record<string, string> }>();

  async function endpointForLease(lease: SandboxLease, abortSignal?: AbortSignal) {
    const cached = endpointCache.get(lease.externalSandboxId);
    if (cached) return cached;
    const details = await client.send(
      new GetMicrovmCommand({ microvmIdentifier: lease.externalSandboxId }),
      abortSignal ? { abortSignal } : undefined,
    );
    const endpoint = readMicrovmEndpoint(details, "getMicrovm");
    endpointCache.set(lease.externalSandboxId, endpoint);
    return endpoint;
  }

  async function authHeadersForLease(lease: SandboxLease, abortSignal?: AbortSignal) {
    const cacheKey = `${lease.externalSandboxId}:${controlPort}`;
    const cached = authTokenCache.get(cacheKey);
    if (cached && cached.expiresAt - now() > authTokenRefreshMarginMs) return cached.headers;
    const result = await client.send(
      new CreateMicrovmAuthTokenCommand({
        allowedPorts: [{ port: controlPort }],
        expirationInMinutes: authTokenTtlMinutes,
        microvmIdentifier: lease.externalSandboxId,
      }),
      abortSignal ? { abortSignal } : undefined,
    );
    const authToken = readLambdaRecord(result, "authToken").authToken;
    const token = readLambdaString(
      readLambdaRecord(authToken, "authToken.authToken")["X-aws-proxy-auth"],
      "authToken.X-aws-proxy-auth",
    );
    const headers = {
      "X-aws-proxy-auth": token,
      "X-aws-proxy-port": String(controlPort),
    };
    authTokenCache.set(cacheKey, {
      expiresAt: now() + authTokenTtlMinutes * 60_000,
      headers,
    });
    return headers;
  }

  async function controlRequest(
    lease: SandboxLease,
    suffix: string,
    init: RequestInit & { duplex?: "half" } = {},
    mutationOperation?: "exec" | "upload",
    onMutationDispatch?: () => void,
  ) {
    const routePath = lambdaControlPath(controlPathPrefix, suffix);
    const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
    const abortSignal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    const endpoint = await endpointForLease(lease, abortSignal);
    const headers = new Headers({
      accept: "application/json",
      ...(await authHeadersForLease(lease, abortSignal)),
    });
    new Headers(init.headers).forEach((value, key) => {
      headers.set(key, value);
    });
    abortSignal.throwIfAborted();
    let response: Response;
    try {
      onMutationDispatch?.();
      response = await fetchImpl(`${endpoint}${routePath}`, {
        ...init,
        headers,
        redirect: "error",
        signal: abortSignal,
      });
    } catch (error) {
      if (mutationOperation) throw new SandboxDataPlaneUnknownError(mutationOperation, error);
      throw error;
    }
    if (!response.ok) {
      await readErrorBody(response);
      const responseError = new LambdaMicrovmControlResponseError(
        `Lambda MicroVM control request failed: ${init.method ?? "GET"} ${routePath} returned ${response.status}`,
        response.status,
      );
      if (mutationOperation && !lambdaControlMutationOutcomeIsDeterministic(responseError)) {
        throw new SandboxDataPlaneUnknownError(mutationOperation, responseError);
      }
      throw responseError;
    }
    return response;
  }

  async function requestJson(
    lease: SandboxLease,
    suffix: string,
    body?: unknown,
    method = "POST",
    signal?: AbortSignal,
    mutationOperation?: "exec" | "upload",
    onMutationDispatch?: () => void,
  ) {
    const init: RequestInit = { method, ...(signal ? { signal } : {}) };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { "content-type": "application/json" };
    }
    const response = await controlRequest(
      lease,
      suffix,
      init,
      mutationOperation,
      onMutationDispatch,
    );
    if (response.status === 204) return null;
    try {
      return await readSandboxJsonResponse(response);
    } catch (error) {
      if (mutationOperation) throw new SandboxDataPlaneUnknownError(mutationOperation, error);
      throw error;
    }
  }

  async function waitUntilReady(
    lease: SandboxLease,
    deadline = Date.now() + readinessTimeoutMs,
    signal?: AbortSignal,
  ) {
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await controlRequest(lease, readinessPath, {
          method: "GET",
          signal: requestSignal(signal, deadline - Date.now()),
        });
        return;
      } catch (error) {
        lastError = error;
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        signal?.throwIfAborted();
        await sleep(Math.min(readinessIntervalMs, remainingMs));
      }
    }
    throw new Error(
      `Lambda MicroVM control service did not become ready within ${readinessTimeoutMs}ms${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
    );
  }

  async function waitUntilSuspended(lease: SandboxLease, signal?: AbortSignal) {
    const deadline = Date.now() + suspensionTimeoutMs;
    let lastState = "unknown";
    let lastError: unknown;
    let firstSuspendedAt: number | undefined;
    let suspendedConfirmations = 0;
    while (Date.now() < deadline) {
      try {
        const details = await client.send(
          new GetMicrovmCommand({ microvmIdentifier: lease.externalSandboxId }),
          { abortSignal: requestSignal(signal, deadline - Date.now()) },
        );
        lastState = readMicrovmState(details, "getMicrovm");
        if (lastState === "SUSPENDED") {
          if (suspendedConfirmations === 0) firstSuspendedAt = now();
          suspendedConfirmations += 1;
        } else {
          firstSuspendedAt = undefined;
          suspendedConfirmations = 0;
        }
        if (suspendedConfirmations >= 3 && firstSuspendedAt !== undefined) {
          return firstSuspendedAt;
        }
      } catch (error) {
        lastError = error;
        firstSuspendedAt = undefined;
        suspendedConfirmations = 0;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      signal?.throwIfAborted();
      await sleep(Math.min(suspensionIntervalMs, remainingMs));
    }
    throw new SandboxCheckpointUnknownError(
      new Error(
        `Lambda MicroVM did not confirm SUSPENDED within ${suspensionTimeoutMs}ms; last state was ${lastState}${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
      ),
    );
  }

  async function waitUntilRunning(
    lease: SandboxLease,
    deadline = Date.now() + readinessTimeoutMs,
    signal?: AbortSignal,
  ) {
    let lastState = "unknown";
    do {
      const details = await client.send(
        new GetMicrovmCommand({ microvmIdentifier: lease.externalSandboxId }),
        { abortSignal: requestSignal(signal, deadline - Date.now()) },
      );
      lastState = readMicrovmState(details, "getMicrovm");
      if (lastState === "RUNNING") return;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      signal?.throwIfAborted();
      await sleep(Math.min(readinessIntervalMs, remainingMs));
    } while (Date.now() < deadline);
    throw new Error(
      `Lambda MicroVM did not reach RUNNING within ${readinessTimeoutMs}ms; last state was ${lastState}`,
    );
  }

  async function runMicrovm(runInput: RunMicrovmRequest, signal?: AbortSignal) {
    let allocationError: unknown;
    for (let attempt = 0; attempt < allocationReconciliationAttempts; attempt += 1) {
      try {
        return await client.send(new RunMicrovmCommand(runInput), {
          abortSignal: requestSignal(signal, requestTimeoutMs),
        });
      } catch (error) {
        if (isDeterministicClientError(error)) throw error;
        allocationError = error;
      }
    }
    throw new SandboxAllocationUnknownError({
      allocationError,
      allocationToken: String(runInput.clientToken),
      automaticReconciliation: Boolean(reconciliationTarget),
    });
  }

  async function reconcileRunningLease(
    lease: SandboxLease,
    currentState?: string,
    allowSuspended = true,
    deadline = Date.now() + readinessTimeoutMs,
    requestedAt?: number,
    signal?: AbortSignal,
  ) {
    let state =
      currentState ??
      readMicrovmState(
        await client.send(new GetMicrovmCommand({ microvmIdentifier: lease.externalSandboxId }), {
          abortSignal: requestSignal(signal, deadline - Date.now()),
        }),
        "getMicrovm",
      );
    if (state === "SUSPENDED" && allowSuspended) {
      let suspendedConfirmations = 1;
      while (Date.now() < deadline) {
        const remainingMs = deadline - Date.now();
        signal?.throwIfAborted();
        await sleep(Math.min(readinessIntervalMs, remainingMs));
        const details = await client.send(
          new GetMicrovmCommand({ microvmIdentifier: lease.externalSandboxId }),
          { abortSignal: requestSignal(signal, deadline - Date.now()) },
        );
        state = readMicrovmState(details, "getMicrovm");
        if (state === "RUNNING") break;
        if (state === "PENDING") {
          await waitUntilRunning(lease, deadline, signal);
          state = "RUNNING";
          break;
        }
        if (state !== "SUSPENDED") {
          throw new Error(`Lambda MicroVM cannot reconcile resume from state ${state}`);
        }
        suspendedConfirmations += 1;
        if (suspendedConfirmations >= 3) {
          if (requestedAt !== undefined && Date.now() - requestedAt >= readinessTimeoutMs) {
            return { ...lease, status: "suspended" as const };
          }
          // AWS can remain SUSPENDED while the resume hook is still running, so stable reads do
          // not prove rollback until the persisted request is older than the readiness window.
          throw new Error("Lambda MicroVM resume remains suspended and requires reconciliation");
        }
      }
      if (state === "SUSPENDED") {
        throw new Error("Lambda MicroVM suspended state could not be confirmed as stable");
      }
    }
    if (state === "SUSPENDED") await waitUntilRunning(lease, deadline, signal);
    else if (state !== "RUNNING" && state !== "PENDING") {
      throw new Error(`Lambda MicroVM cannot reconcile resume from state ${state}`);
    } else if (state !== "RUNNING") await waitUntilRunning(lease, deadline, signal);
    endpointCache.delete(lease.externalSandboxId);
    const ready = { ...lease, status: "ready" as const };
    await waitUntilReady(ready, deadline, signal);
    return ready;
  }

  async function reconcileCheckpointLease(
    lease: SandboxLease,
    requestedAt = now(),
    signal?: AbortSignal,
  ): Promise<CheckpointReconciliation> {
    if (!Number.isFinite(requestedAt)) {
      throw new Error("Lambda MicroVM checkpoint requestedAt must be finite");
    }
    const deadline = Date.now() + suspensionTimeoutMs;
    let details = await client.send(
      new GetMicrovmCommand({ microvmIdentifier: lease.externalSandboxId }),
      { abortSignal: requestSignal(signal, deadline - Date.now()) },
    );
    let state = readMicrovmState(details, "getMicrovm");
    if (state === "RUNNING") {
      let runningConfirmations = 1;
      while (runningConfirmations < 3 && Date.now() < deadline) {
        const remainingMs = deadline - Date.now();
        signal?.throwIfAborted();
        await sleep(Math.min(suspensionIntervalMs, remainingMs));
        details = await client.send(
          new GetMicrovmCommand({ microvmIdentifier: lease.externalSandboxId }),
          { abortSignal: requestSignal(signal, deadline - Date.now()) },
        );
        state = readMicrovmState(details, "getMicrovm");
        if (state !== "RUNNING") break;
        runningConfirmations += 1;
      }
      if (runningConfirmations >= 3) {
        if (Date.now() - requestedAt < suspensionTimeoutMs) {
          throw new Error("Lambda MicroVM checkpoint remains running and requires reconciliation");
        }
        const ready = { ...lease, status: "ready" as const };
        await waitUntilReady(ready, deadline, signal);
        return { lease: ready };
      }
    }
    if (state !== "SUSPENDED" && state !== "SUSPENDING") {
      throw new Error(`Lambda MicroVM cannot reconcile checkpoint from state ${state}`);
    }
    let suspendedConfirmations = state === "SUSPENDED" ? 1 : 0;
    while (suspendedConfirmations < 3 && Date.now() < deadline) {
      const remainingMs = deadline - Date.now();
      signal?.throwIfAborted();
      await sleep(Math.min(suspensionIntervalMs, remainingMs));
      details = await client.send(
        new GetMicrovmCommand({ microvmIdentifier: lease.externalSandboxId }),
        { abortSignal: requestSignal(signal, deadline - Date.now()) },
      );
      state = readMicrovmState(details, "getMicrovm");
      if (state === "SUSPENDED") {
        suspendedConfirmations += 1;
      } else if (state === "SUSPENDING") {
        suspendedConfirmations = 0;
      } else {
        throw new Error(`Lambda MicroVM suspended state was not stable; observed ${state}`);
      }
    }
    if (suspendedConfirmations < 3) {
      throw new Error("Lambda MicroVM suspended state could not be confirmed as stable");
    }
    return {
      checkpoint: {
        checkpointRef: `lambda-microvm://${lease.externalSandboxId}/suspended`,
        createdAt: requestedAt,
        provider: "aws_lambda_microvm",
      },
      lease: { ...lease, status: "suspended" },
    };
  }

  return {
    allocationFingerprint,
    automaticAllocationReconciliation: Boolean(reconciliationTarget),
    name: "aws_lambda_microvm",
    provisioningReservation: () => ({
      reservedMemoryMiB: imageMemoryMiB,
      reservedVcpu: imageVcpu,
    }),
    providerRouteKeyForLease: () => providerRouteKey,
    validateLeaseRoute: assertProviderRoute,
    async checkpoint(input) {
      assertProviderRoute(input.lease);
      try {
        await client.send(
          new SuspendMicrovmCommand({
            microvmIdentifier: input.lease.externalSandboxId,
          }),
          { abortSignal: requestSignal(input.signal, suspensionTimeoutMs) },
        );
      } catch (error) {
        if (isDeterministicClientError(error) && !isStateConflict(error)) throw error;
        // A timeout or state conflict can precede an already-applied suspension.
      }
      let suspendedAt: number;
      try {
        suspendedAt = await waitUntilSuspended(input.lease, input.signal);
      } catch (error) {
        if (error instanceof SandboxCheckpointUnknownError) throw error;
        throw new SandboxCheckpointUnknownError(error);
      }
      return {
        checkpointRef: `lambda-microvm://${input.lease.externalSandboxId}/suspended`,
        createdAt: suspendedAt,
        provider: "aws_lambda_microvm",
      };
    },
    async create(input) {
      if (
        (input.minMemoryMiB !== undefined &&
          (!Number.isFinite(input.minMemoryMiB) ||
            input.minMemoryMiB <= 0 ||
            input.minMemoryMiB > imageMemoryMiB)) ||
        (input.minVcpu !== undefined &&
          (!Number.isFinite(input.minVcpu) || input.minVcpu <= 0 || input.minVcpu > imageVcpu))
      ) {
        throw new Error(
          `Lambda MicroVM image capacity is ${imageVcpu} vCPU and ${imageMemoryMiB} MiB`,
        );
      }
      const runInput = runInputFor(input);
      if (
        input.expectedAllocationFingerprint &&
        input.expectedAllocationFingerprint !== fingerprintFor(runInput)
      ) {
        throw new Error("Lambda MicroVM allocation configuration fingerprint changed");
      }
      const result = await runMicrovm(runInput, input.signal);
      let externalSandboxId: string;
      try {
        externalSandboxId = readMicrovmId(result, "runMicrovm");
      } catch (allocationError) {
        throw new SandboxAllocationUnknownError({
          allocationError,
          allocationToken: String(runInput.clientToken),
          automaticReconciliation: Boolean(reconciliationTarget),
        });
      }
      let lease: SandboxLease = {
        environmentId: input.environmentId,
        executionTargetId: input.executionTargetId,
        executionTargetKind: input.executionTargetKind,
        externalSandboxId,
        imageRef: lambdaMicrovmImageRef(config),
        isolationMode: input.isolationMode,
        organizationId: input.organizationId,
        projectId: input.projectId,
        provider: "aws_lambda_microvm",
        providerRouteKey,
        reservedMemoryMiB: imageMemoryMiB,
        reservedVcpu: imageVcpu,
        status: "error",
        ...(input.accessPolicyRef ? { accessPolicyRef: input.accessPolicyRef } : {}),
        ...(input.poolKey ? { poolKey: input.poolKey } : {}),
        ...(effectiveRegion ? { region: effectiveRegion } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      };
      try {
        lease = { ...lease, ...readRunTiming(result) };
        const endpoint = readMicrovmEndpoint(result, "runMicrovm");
        lease = { ...lease, status: "ready" };
        endpointCache.set(externalSandboxId, endpoint);
        await waitUntilReady(lease, undefined, input.signal);
        return lease;
      } catch (error) {
        endpointCache.delete(externalSandboxId);
        authTokenCache.delete(`${externalSandboxId}:${controlPort}`);
        try {
          await client.send(
            new TerminateMicrovmCommand({
              microvmIdentifier: externalSandboxId,
            }),
            {
              abortSignal: requestSignal(undefined, requestTimeoutMs),
            },
          );
        } catch (cleanupError) {
          if (!isResourceNotFound(cleanupError)) {
            throw new SandboxAllocationCleanupError({
              allocationError: error,
              cleanupError,
              lease,
            });
          }
        }
        throw new SandboxAllocationLeaseError({
          allocationError: error,
          cleanupCompletedAt: now(),
          lease,
        });
      }
    },
    async destroy(input) {
      assertProviderRoute(input.lease);
      try {
        await client.send(
          new TerminateMicrovmCommand({
            microvmIdentifier: input.lease.externalSandboxId,
          }),
          { abortSignal: requestSignal(input.signal, requestTimeoutMs) },
        );
      } catch (error) {
        if (!isResourceNotFound(error)) {
          if (isDeterministicClientError(error)) throw error;
          throw new SandboxDestroyUnknownError(error);
        }
      }
      endpointCache.delete(input.lease.externalSandboxId);
      authTokenCache.delete(`${input.lease.externalSandboxId}:${controlPort}`);
    },
    async download(input) {
      assertProviderRoute(input.lease);
      const response = await controlRequest(
        input.lease,
        `/files?path=${encodeURIComponent(input.path)}`,
        { method: "GET", ...(input.signal ? { signal: input.signal } : {}) },
      );
      if (!response.body) {
        throw new Error("Lambda MicroVM download response did not include a body");
      }
      return response.body;
    },
    async exec(input) {
      assertProviderRoute(input.lease);
      // Isolation is a separate route, never a body field: a guest whose control server predates
      // it answers 404 instead of silently running the command with the sandbox's egress.
      const isolated = input.network === "none";
      const result = await requestJson(
        input.lease,
        isolated ? "/exec-isolated" : "/exec",
        {
          command: input.command,
          cwd: input.cwd,
          env: input.env,
          timeoutMs: input.timeoutMs,
        },
        "POST",
        input.signal,
        "exec",
        input.onMutationDispatch,
      ).catch((error: unknown) => {
        throw isolated ? lambdaIsolatedExecRefusal(error) : error;
      });
      try {
        return readExecResponse(result, input.lease);
      } catch (error) {
        throw new SandboxDataPlaneUnknownError("exec", error);
      }
    },
    reconcileCheckpoint(input) {
      assertProviderRoute(input.lease);
      return reconcileCheckpointLease(input.lease, input.requestedAt, input.signal);
    },
    reconcileResume(input) {
      assertProviderRoute(input.lease);
      return reconcileRunningLease(
        input.lease,
        undefined,
        true,
        undefined,
        input.requestedAt,
        input.signal,
      );
    },
    async resume(input) {
      assertProviderRoute(input.lease);
      const deadline = Date.now() + readinessTimeoutMs;
      const current = await client.send(
        new GetMicrovmCommand({
          microvmIdentifier: input.lease.externalSandboxId,
        }),
        { abortSignal: requestSignal(input.signal, deadline - Date.now()) },
      );
      const currentState = readMicrovmState(current, "getMicrovm");
      let resumeError: unknown;
      if (currentState === "SUSPENDED") {
        try {
          input.onMutationDispatch?.();
          await client.send(
            new ResumeMicrovmCommand({
              microvmIdentifier: input.lease.externalSandboxId,
            }),
            { abortSignal: requestSignal(input.signal, deadline - Date.now()) },
          );
        } catch (error) {
          if (isDeterministicClientError(error) && !isStateConflict(error)) throw error;
          resumeError = error;
        }
      } else if (currentState !== "RUNNING" && currentState !== "PENDING") {
        throw new Error(`Lambda MicroVM cannot resume from state ${currentState}`);
      }
      try {
        return await reconcileRunningLease(
          input.lease,
          currentState === "RUNNING" ? currentState : undefined,
          false,
          deadline,
          undefined,
          input.signal,
        );
      } catch (reconciliationError) {
        throw new SandboxResumeUnknownError(
          resumeError === undefined ? reconciliationError : { reconciliationError, resumeError },
        );
      }
    },
    async upload(input) {
      assertProviderRoute(input.lease);
      const init: RequestInit & { duplex?: "half" } = {
        body: input.content as NonNullable<RequestInit["body"]>,
        method: "PUT",
        ...(input.signal ? { signal: input.signal } : {}),
      };
      if (!(input.content instanceof Uint8Array)) init.duplex = "half";
      await controlRequest(
        input.lease,
        `/files?path=${encodeURIComponent(input.path)}`,
        init,
        "upload",
        input.onMutationDispatch,
      );
    },
    validateReadyLease(lease, signal) {
      assertProviderRoute(lease);
      return reconcileRunningLease(lease, undefined, false, undefined, undefined, signal);
    },
  };
}
