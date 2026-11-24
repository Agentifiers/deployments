import type { RuntimeToolExecutionResult } from "@deployments-ai/agent-runtime";
import {
  runtimeToolInputHash,
  RuntimeToolExecutionKnownFailureError,
  RuntimeToolPreparationRetryableError,
} from "@deployments-ai/agent-runtime";
import { hasRequiredScopes } from "@deployments-ai/providers";
import {
  canonicalScopes,
  executeProviderNativeHttpTool,
  ProviderNativeExecutionKnownFailureError,
  ProviderNativeExecutionRetryableError,
  type ProviderNativeCredential,
} from "@deployments-ai/tools";
import {
  RuntimeProviderMutationIdentityConflictError,
  RuntimeProviderMutationKnownFailureError,
  RuntimeProviderMutationOutcomeUnknownError,
  type RuntimeProviderMutationClaim,
  type RuntimeProviderMutationClaimInput,
  type RuntimeProviderMutationClaimStart,
  type RuntimeProviderMutationClaimStore,
} from "./provider-mutation-claims.ts";
import {
  executeRuntimeHttpCallback,
  prepareRuntimeHttpCallback,
  RuntimeHttpCallbackKnownFailureError,
  RuntimeHttpCallbackOutcomeUnknownError,
  RuntimeHttpCallbackRetryableError,
  type RuntimeCallbackWorkspaceFile,
} from "./runtime-http-callback.ts";
import {
  RuntimeHttpCallbackDispatchPermanentError,
  type RuntimeHttpCallbackDispatch,
} from "./runtime-http-callback-dispatch.ts";
import {
  builtinMutationClaimIdempotencyKey,
  providerMutationRequestIdempotencyKey,
} from "./runtime-idempotency.ts";
import { pauseClientToolCall } from "./client-runtime-tools.ts";
import { sandboxCapacityRefusal } from "./sandbox-capacity-refusal.ts";
import { isDeepStrictEqual } from "node:util";

import {
  acceptsProvider,
  assertExecutionPlanMatches,
  builtinExecutionBinding,
  canonicalProvider,
  executionPlan,
  positiveArtifactLimit,
  runtimeArtifact,
  type AuthorizedRuntimeToolBindingRequest,
  type ExecuteRuntimeBuiltinTool,
  type RuntimeToolAuthorizationContext,
  type RuntimeToolBindingOptions,
  type RuntimeToolService,
} from "./runtime-tool-planning.ts";
import {
  assertEgressAdmittedAtExecution,
  createRuntimeToolCallAuthorizer,
  runtimeToolDefinitionLookup,
  toolOutsideDataBoundaryMessage,
  ToolOutsideDataBoundaryError,
} from "./runtime-tool-call-authorization.ts";

function durableExecutionResult(result: RuntimeToolExecutionResult): RuntimeToolExecutionResult {
  const { transientArtifacts: _transientArtifacts, ...durable } = result;
  return durable;
}

function builtinMutationClaimResult(
  executor: ExecuteRuntimeBuiltinTool,
  result: RuntimeToolExecutionResult,
) {
  return durableExecutionResult(executor.mutationClaimResult?.(result) ?? result);
}

/** Begins a durable mutation claim; storage failures are retryable before any dispatch. */
async function beginMutationClaim(
  claims: RuntimeProviderMutationClaimStore,
  input: RuntimeProviderMutationClaimInput,
): Promise<RuntimeProviderMutationClaimStart> {
  try {
    return await claims.begin(input);
  } catch (cause) {
    if (
      cause instanceof RuntimeProviderMutationKnownFailureError ||
      cause instanceof RuntimeProviderMutationOutcomeUnknownError ||
      cause instanceof RuntimeProviderMutationIdentityConflictError
    ) {
      throw cause;
    }
    throw new RuntimeToolPreparationRetryableError(input.toolName, cause);
  }
}

function canonicalHandoffProviderResult(
  result: Awaited<ReturnType<typeof executeProviderNativeHttpTool>>,
  toolName: string,
): Awaited<ReturnType<typeof executeProviderNativeHttpTool>> {
  const artifactBody = JSON.stringify(
    {
      handoffResponseRecorded: true,
      provider: result.provider,
      responseStatus: result.responseStatus,
      toolName,
    },
    null,
    2,
  );
  return {
    ...result,
    artifactBody,
    contentType: "application/json",
    outputSummary: `${toolName} artifact handoff completed with status ${result.responseStatus}.`,
    parsedBody: undefined,
    sourceCharacterCount: artifactBody.length,
  };
}

export function createRuntimeToolService(options: RuntimeToolBindingOptions): RuntimeToolService {
  const maximumArtifactCharacters = positiveArtifactLimit(options.maxArtifactCharacters);
  const definitionFor = runtimeToolDefinitionLookup(options);

  return {
    resolveToolDefinition: async (toolName, context) => {
      const lookup = await definitionFor(toolName, context);
      if (lookup.kind === "outside-boundary") throw new ToolOutsideDataBoundaryError(lookup);
      if (lookup.kind === "missing") return undefined;
      const { definition } = lookup;
      return {
        description: definition.description,
        effect: definition.effect,
        ...(definition.inputSchema &&
        typeof definition.inputSchema === "object" &&
        !Array.isArray(definition.inputSchema)
          ? { inputSchema: definition.inputSchema as Readonly<Record<string, unknown>> }
          : {}),
        requiredScopes: canonicalScopes(definition.requiredScopes),
        toolName: definition.toolName,
      };
    },

    authorizeToolCall: createRuntimeToolCallAuthorizer(options, definitionFor),

    executeToolCall: async (request) => {
      let claim: RuntimeProviderMutationClaim | undefined;
      let executorInvoked = false;
      let releasePreparedInputOnRetry: (() => Promise<void>) | undefined;
      try {
        const lookup = await definitionFor(request.toolName, request);
        if (lookup.kind === "outside-boundary") {
          // An approved continuation reaches execution without a fresh authorization.
          throw new RuntimeToolExecutionKnownFailureError(
            request.toolName,
            new Error(toolOutsideDataBoundaryMessage(lookup)),
          );
        }
        if (lookup.kind === "missing") {
          throw new Error(`Runtime tool ${request.toolName} has no active execution binding.`);
        }
        const adapter = lookup.definition;
        if (lookup.egressGate) {
          await assertEgressAdmittedAtExecution(options, adapter, request, lookup.egressGate);
        }
        const plan = executionPlan(adapter, options.builtinExecutors);
        if (plan.kind === "client") return pauseClientToolCall(plan, request, new Date());
        if (plan.kind === "builtin" || plan.kind === "hosted-code") {
          const binding = request.decision.executionBinding;
          const expectedBinding = builtinExecutionBinding(plan);
          if (
            !binding ||
            binding.authorizationFingerprint !== expectedBinding.authorizationFingerprint ||
            binding.connectionId !== expectedBinding.connectionId ||
            binding.externalAccountId !== expectedBinding.externalAccountId ||
            binding.toolAdapterId !== expectedBinding.toolAdapterId ||
            (binding.inputHash !== undefined &&
              binding.inputHash !== runtimeToolInputHash(request.input ?? {}))
          ) {
            throw new RuntimeToolExecutionKnownFailureError(
              request.toolName,
              new Error(
                `Runtime tool ${request.toolName} is missing its authorized built-in execution binding.`,
              ),
            );
          }
          assertExecutionPlanMatches(binding, request, plan);
          const refused = plan.executor.preflight?.(request);
          if (refused) return refused;
          if (
            plan.effect !== "read" &&
            plan.adapter.providerOutboundMutation === true &&
            !options.mutationClaims
          ) {
            throw new Error(
              `Runtime tool ${request.toolName} requires durable provider mutation claims.`,
            );
          }
          if (
            plan.effect !== "read" &&
            plan.adapter.providerOutboundMutation === true &&
            options.mutationClaims
          ) {
            const started = await beginMutationClaim(options.mutationClaims, {
              binding,
              effect: plan.effect,
              environmentId: request.environmentId,
              idempotencyKey: builtinMutationClaimIdempotencyKey({
                ...(request.input ? { input: request.input } : {}),
                requestIdempotencyKey: request.idempotencyKey,
                runId: request.runId,
                toolName: request.toolName,
              }),
              ...(request.input ? { input: request.input } : {}),
              organizationId: request.organizationId,
              projectId: request.projectId,
              runId: request.runId,
              threadId: request.threadId,
              toolCallId: request.decision.toolCallId,
              toolName: request.toolName,
            });
            if (started.action === "replay") {
              if (!plan.executor.refreshReplay) return started.result;
              try {
                const refreshed = await plan.executor.refreshReplay(
                  request,
                  plan.adapter,
                  started.result,
                );
                if (
                  !isDeepStrictEqual(
                    builtinMutationClaimResult(plan.executor, refreshed),
                    durableExecutionResult(started.result),
                  )
                ) {
                  throw new TypeError("Replay refresh changed the persisted tool result.");
                }
                return refreshed;
              } catch (cause) {
                if (cause instanceof RuntimeToolPreparationRetryableError) throw cause;
                if (cause instanceof TypeError) {
                  throw new RuntimeToolExecutionKnownFailureError(request.toolName, cause);
                }
                throw new RuntimeToolPreparationRetryableError(request.toolName, cause);
              }
            }
            claim = started.claim;
          }
          executorInvoked = true;
          try {
            const execution = await plan.executor(request, plan.adapter);
            if (claim) {
              await options.mutationClaims!.succeed(
                claim,
                builtinMutationClaimResult(plan.executor, execution),
              );
            }
            return execution;
          } catch (cause) {
            if (
              cause instanceof RuntimeToolExecutionKnownFailureError ||
              cause instanceof RuntimeToolPreparationRetryableError
            ) {
              throw cause;
            }
            if (cause instanceof TypeError) {
              throw new RuntimeToolExecutionKnownFailureError(request.toolName, cause);
            }
            if (plan.effect === "read") {
              throw new RuntimeToolPreparationRetryableError(request.toolName, cause);
            }
            throw cause;
          }
        }
        if (!request.decision.executionBinding) {
          throw new Error("Provider tool execution requires a pinned authorization binding.");
        }
        const binding = request.decision.executionBinding;
        assertExecutionPlanMatches(binding, request, plan);
        const authorizedRequest: AuthorizedRuntimeToolBindingRequest = {
          ...request,
          decision: { ...request.decision, executionBinding: binding },
        };
        if (plan.kind === "mcp-read" || plan.kind === "mcp-mutation") {
          if (!plan.vendor) {
            if (!options.executeMcpTool) {
              throw new Error(`Runtime tool ${request.toolName} has no active MCP binding.`);
            }
            return await options.executeMcpTool(authorizedRequest, plan.adapter, plan.mcpToolName);
          }
          if (!options.executeVendorMcpTool) {
            throw new Error(`Runtime tool ${request.toolName} has no active MCP binding.`);
          }
          if (plan.kind === "mcp-mutation") {
            if (
              !request.policyAction ||
              Boolean(request.approvalId) !== (request.policyAction === "require-approval")
            ) {
              throw new RuntimeToolExecutionKnownFailureError(
                request.toolName,
                new Error("MCP mutation execution is missing its original policy provenance."),
              );
            }
            if (!options.mutationClaims) {
              throw new Error(
                `Runtime tool ${request.toolName} requires durable provider mutation claims.`,
              );
            }
            // MCP has no idempotency key on the wire: the claim on the logical tool-call key is
            // the only replay guard, and an ambiguous dispatch is quarantined, not redispatched.
            const started = await beginMutationClaim(options.mutationClaims, {
              binding,
              effect: plan.effect,
              environmentId: request.environmentId,
              idempotencyKey: request.idempotencyKey,
              ...(request.input ? { input: request.input } : {}),
              organizationId: request.organizationId,
              projectId: request.projectId,
              runId: request.runId,
              threadId: request.threadId,
              toolCallId: request.decision.toolCallId,
              toolName: request.toolName,
            });
            if (started.action === "replay") return started.result;
            claim = started.claim;
            executorInvoked = true;
          }
          const execution = await options.executeVendorMcpTool(
            authorizedRequest,
            plan.adapter,
            plan.vendor,
          );
          if (claim) await options.mutationClaims!.succeed(claim, execution);
          return execution;
        }
        if (plan.kind === "http-callback") {
          let context: RuntimeToolAuthorizationContext | undefined;
          try {
            context = await options.resolveAuthorizationContext(authorizedRequest, plan.adapter);
          } catch (cause) {
            throw new RuntimeToolPreparationRetryableError(request.toolName, cause);
          }
          if (
            !context ||
            context.authorizationFingerprint !== binding.authorizationFingerprint ||
            context.connectionId !== binding.connectionId ||
            context.externalAccountId !== binding.externalAccountId
          ) {
            throw new RuntimeToolExecutionKnownFailureError(
              request.toolName,
              new Error("HTTP callback authorization changed after the tool policy decision."),
            );
          }
          if (
            !plan.adapter.provider ||
            canonicalProvider(plan.adapter.provider) !==
              canonicalProvider(context.connectorProvider)
          ) {
            throw new RuntimeToolExecutionKnownFailureError(
              request.toolName,
              new Error("HTTP callback provider authorization does not match."),
            );
          }
          if (
            !hasRequiredScopes({
              grantedScopes: canonicalScopes(context.grantedScopes),
              requiredScopes: plan.requiredScopes,
            })
          ) {
            throw new RuntimeToolExecutionKnownFailureError(
              request.toolName,
              new Error("HTTP callback authorization scopes are insufficient."),
            );
          }
          const effectiveInput = {
            ...request.input,
            ...context.externalResourceConstraints,
          };
          if (!binding.inputHash || runtimeToolInputHash(effectiveInput) !== binding.inputHash) {
            throw new RuntimeToolExecutionKnownFailureError(
              request.toolName,
              new Error("HTTP callback input changed after the tool policy decision."),
            );
          }
          if (
            !request.policyAction ||
            Boolean(request.approvalId) !== (request.policyAction === "require-approval")
          ) {
            throw new RuntimeToolExecutionKnownFailureError(
              request.toolName,
              new Error("HTTP callback execution is missing its original policy provenance."),
            );
          }
          if (!options.persistHttpCallbackDispatch) {
            throw new Error(
              `Runtime tool ${request.toolName} requires durable HTTP callback dispatch evidence.`,
            );
          }
          const workspaceFilesSpec = plan.execution.workspaceFiles;
          if (workspaceFilesSpec) {
            if (authorizedRequest.sandboxPolicy?.mode !== "thread-persistent") {
              throw new RuntimeHttpCallbackKnownFailureError(
                request.toolName,
                `HTTP callback ${request.toolName} attaches workspace files and requires a thread-persistent sandbox policy.`,
              );
            }
            if (!options.readCallbackWorkspaceFiles) {
              throw new RuntimeHttpCallbackKnownFailureError(
                request.toolName,
                `HTTP callback ${request.toolName} attaches workspace files, but thread-persistent sandboxes are not configured.`,
              );
            }
          }
          prepareRuntimeHttpCallback({
            callbackEvidenceId: request.decision.toolCallId,
            definition: plan.adapter,
            effect: plan.effect,
            effectiveInput,
            execution: plan.execution,
            ...(options.executor ? { options: options.executor } : {}),
            request: authorizedRequest,
          });
          if (plan.effect !== "read") {
            if (!options.mutationClaims) {
              throw new Error(
                `Runtime tool ${request.toolName} requires durable provider mutation claims.`,
              );
            }
            const started = await beginMutationClaim(options.mutationClaims, {
              binding,
              effect: plan.effect,
              environmentId: request.environmentId,
              idempotencyKey: request.idempotencyKey,
              input: effectiveInput,
              organizationId: request.organizationId,
              projectId: request.projectId,
              runId: request.runId,
              threadId: request.threadId,
              toolCallId: request.decision.toolCallId,
              toolName: request.toolName,
            });
            if (started.action === "replay") return started.result;
            claim = started.claim;
          }
          // Read only once the call will really dispatch: a replay above returns the stored result
          // without touching the sandbox, and a claimed call releases its claim on retryable
          // failures and records known (limit) failures, as for any pre-dispatch error.
          let workspaceFiles: readonly RuntimeCallbackWorkspaceFile[] | undefined;
          if (workspaceFilesSpec) {
            try {
              workspaceFiles = await options.readCallbackWorkspaceFiles!(
                authorizedRequest,
                workspaceFilesSpec,
              );
            } catch (cause) {
              if (cause instanceof RuntimeHttpCallbackKnownFailureError) throw cause;
              throw new RuntimeToolPreparationRetryableError(request.toolName, cause);
            }
          }
          let dispatch: RuntimeHttpCallbackDispatch;
          try {
            dispatch = await options.persistHttpCallbackDispatch(
              authorizedRequest,
              effectiveInput,
              context.callbackControlSnapshot,
              plan.execution.runContext,
              (origin) => {
                prepareRuntimeHttpCallback({
                  callbackEvidenceId: request.decision.toolCallId,
                  definition: plan.adapter,
                  effect: plan.effect,
                  effectiveInput,
                  execution: plan.execution,
                  ...(options.executor ? { options: options.executor } : {}),
                  ...(origin ? { origin } : {}),
                  request: authorizedRequest,
                  ...(workspaceFiles ? { workspaceFiles } : {}),
                });
              },
            );
          } catch (cause) {
            if (cause instanceof RuntimeHttpCallbackKnownFailureError) throw cause;
            if (cause instanceof RuntimeHttpCallbackDispatchPermanentError) {
              throw new RuntimeToolExecutionKnownFailureError(request.toolName, cause);
            }
            throw new RuntimeToolPreparationRetryableError(request.toolName, cause);
          }
          executorInvoked = true;
          const execution = await executeRuntimeHttpCallback({
            callbackEvidenceId: dispatch.evidenceId,
            definition: plan.adapter,
            effect: plan.effect,
            effectiveInput,
            execution: plan.execution,
            maximumArtifactCharacters,
            ...(options.executor ? { options: options.executor } : {}),
            ...(dispatch.origin ? { origin: dispatch.origin } : {}),
            request: authorizedRequest,
            ...(workspaceFiles ? { workspaceFiles } : {}),
          });
          if (claim) await options.mutationClaims!.succeed(claim, execution);
          return execution;
        }
        const definition = plan.definition;
        if (plan.kind === "provider-mutation") {
          if (!options.mutationClaims) {
            throw new Error(
              `Runtime tool ${request.toolName} requires durable provider mutation claims.`,
            );
          }
          const started = await beginMutationClaim(options.mutationClaims, {
            binding,
            effect: plan.effect,
            environmentId: request.environmentId,
            idempotencyKey: request.idempotencyKey,
            ...(request.input ? { input: request.input } : {}),
            organizationId: request.organizationId,
            projectId: request.projectId,
            runId: request.runId,
            threadId: request.threadId,
            toolCallId: request.decision.toolCallId,
            toolName: request.toolName,
          });
          if (started.action === "replay") return started.result;
          claim = started.claim;
        }
        let credential: ProviderNativeCredential;
        try {
          credential = await options.resolveProviderCredential(authorizedRequest, definition);
        } catch (cause) {
          if (cause instanceof RuntimeToolExecutionKnownFailureError) throw cause;
          throw new RuntimeToolPreparationRetryableError(request.toolName, cause);
        }
        if (!acceptsProvider(definition, credential.provider)) {
          throw new Error(`Runtime tool ${request.toolName} credential provider does not match.`);
        }
        if (
          credential.connectionId !== binding.connectionId ||
          credential.externalAccountId.trim() !== binding.externalAccountId ||
          credential.authorizationFingerprint?.trim() !== binding.authorizationFingerprint
        ) {
          throw new Error(
            `Runtime tool ${request.toolName} credential authorization binding does not match.`,
          );
        }
        if (
          !hasRequiredScopes({
            grantedScopes: canonicalScopes(credential.grantedScopes),
            requiredScopes: plan.requiredScopes,
          })
        ) {
          throw new Error(`Runtime tool ${request.toolName} credential scopes are insufficient.`);
        }
        let preparedInput = request.input ?? {};
        let persistCanonicalHandoffResponse = false;
        if (options.prepareProviderInput) {
          try {
            const prepared = await options.prepareProviderInput(authorizedRequest, definition);
            preparedInput = prepared.input;
            persistCanonicalHandoffResponse = prepared.persistCanonicalHandoffResponse === true;
            releasePreparedInputOnRetry = prepared.releaseOnRetry;
          } catch (cause) {
            if (cause instanceof RuntimeToolPreparationRetryableError) throw cause;
            if (cause instanceof TypeError) {
              throw new RuntimeToolExecutionKnownFailureError(request.toolName, cause);
            }
            throw new RuntimeToolPreparationRetryableError(request.toolName, cause);
          }
        }
        executorInvoked = true;
        const providerRequestIdempotencyKeyValue = providerMutationRequestIdempotencyKey(
          request.runId,
          request.idempotencyKey,
        );
        const result = await executeProviderNativeHttpTool(
          {
            credential,
            definition,
            input: preparedInput,
            request: {
              idempotencyKey: providerRequestIdempotencyKeyValue,
              toolCallId: request.decision.toolCallId,
              toolName: request.toolName,
            },
            ...(request.signal ? { signal: request.signal } : {}),
          },
          options.executor,
        );
        const persistedResult = persistCanonicalHandoffResponse
          ? canonicalHandoffProviderResult(result, definition.toolName)
          : result;
        const execution = {
          artifacts: [
            runtimeArtifact(
              persistedResult,
              definition,
              providerRequestIdempotencyKeyValue,
              request.decision.toolCallId,
              maximumArtifactCharacters,
            ),
          ],
          ...(persistedResult.externalOperationId
            ? { externalOperationId: persistedResult.externalOperationId }
            : {}),
          outputSummary: persistedResult.outputSummary,
          status: "completed" as const,
        };
        if (claim) await options.mutationClaims!.succeed(claim, execution);
        return execution;
      } catch (cause) {
        const refusal = sandboxCapacityRefusal(request.toolName, cause);
        if (refusal) {
          if (claim) {
            try {
              await options.mutationClaims!.release(claim);
            } catch (releaseCause) {
              throw new RuntimeToolPreparationRetryableError(
                request.toolName,
                new AggregateError(
                  [cause, releaseCause],
                  "Sandbox capacity refusal cleanup failed.",
                ),
              );
            }
          }
          return refusal;
        }
        if (
          cause instanceof RuntimeToolPreparationRetryableError ||
          cause instanceof ProviderNativeExecutionRetryableError ||
          cause instanceof RuntimeHttpCallbackRetryableError
        ) {
          const releaseFailures: unknown[] = [];
          if (releasePreparedInputOnRetry) {
            try {
              await releasePreparedInputOnRetry();
            } catch (releaseCause) {
              releaseFailures.push(releaseCause);
            }
          }
          if (claim) {
            try {
              await options.mutationClaims!.release(claim);
            } catch (releaseCause) {
              releaseFailures.push(releaseCause);
            }
          }
          if (releaseFailures.length > 0) {
            throw new RuntimeToolPreparationRetryableError(
              request.toolName,
              new AggregateError([cause, ...releaseFailures], "Provider retry cleanup failed."),
            );
          }
          throw cause instanceof RuntimeToolPreparationRetryableError
            ? cause
            : new RuntimeToolPreparationRetryableError(request.toolName, cause);
        }
        const knownFailure =
          cause instanceof RuntimeToolPreparationRetryableError
            ? undefined
            : cause instanceof RuntimeToolExecutionKnownFailureError
              ? cause
              : cause instanceof ProviderNativeExecutionKnownFailureError ||
                  cause instanceof RuntimeHttpCallbackKnownFailureError ||
                  cause instanceof RuntimeProviderMutationKnownFailureError ||
                  (!executorInvoked &&
                    !(cause instanceof RuntimeProviderMutationOutcomeUnknownError) &&
                    !(cause instanceof RuntimeHttpCallbackOutcomeUnknownError))
                ? new RuntimeToolExecutionKnownFailureError(request.toolName, cause)
                : undefined;
        if (claim) {
          try {
            if (knownFailure) await options.mutationClaims!.fail(claim, knownFailure);
            else await options.mutationClaims!.markUnknown(claim, cause);
          } catch (persistenceCause) {
            throw new AggregateError(
              [cause, persistenceCause],
              `Provider mutation ${request.toolName} outcome could not be persisted.`,
            );
          }
        }
        if (knownFailure) throw knownFailure;
        throw cause;
      }
    },
  };
}

export const createRuntimeToolDependencies = createRuntimeToolService;
