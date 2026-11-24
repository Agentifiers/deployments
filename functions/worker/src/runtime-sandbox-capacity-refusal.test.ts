import { describe, expect, test } from "bun:test";
import type { RuntimeToolDecision } from "@deployments-ai/agent-runtime";
import { dataBoundaryOf, type Ulid } from "@deployments-ai/db";
import { SandboxCapacityError, type SandboxManagerService } from "@deployments-ai/sandbox-hosts";
import { Effect } from "effect";
import { createRuntimeCodeBuiltinExecutors } from "./code-runtime-tools.ts";
import type {
  RuntimeProviderMutationClaim,
  RuntimeProviderMutationClaimStore,
} from "./provider-mutation-claims.ts";
import { createRuntimeToolService } from "./runtime-tool-authorization.ts";
import type { RuntimeToolBindingRequest } from "./runtime-tools.ts";
import type { ThreadSandboxWorkspace } from "./thread-sandbox/contracts.ts";

const id = (suffix: string) => `01J000000000000000000000${suffix}` as Ulid;
const REFUSAL_MESSAGE =
  "This organization reached its limit of 2 active sandboxes, so code.execute did not run. Try again after other sandbox work finishes, or continue without it.";

const capacityError = new SandboxCapacityError({
  inUse: 2,
  limit: 2,
  message: "The organization reached its limit of 2 active sandboxes.",
  organizationId: id("05"),
});

function codeTool(mode: "run-ephemeral" | "thread-persistent") {
  const claims: string[] = [];
  const mutationClaims: RuntimeProviderMutationClaimStore = {
    begin: async () => {
      claims.push("begin");
      return { action: "execute", claim: {} as RuntimeProviderMutationClaim };
    },
    fail: async () => void claims.push("fail"),
    markUnknown: async () => void claims.push("unknown"),
    release: async () => void claims.push("release"),
    succeed: async () => void claims.push("succeed"),
  };
  const manager = {
    create: () => Effect.fail(capacityError),
  } as unknown as SandboxManagerService;
  const threadSandbox: ThreadSandboxWorkspace = {
    acquire: async () => {
      throw new Error("Thread sandbox allocation did not complete.", { cause: capacityError });
    },
    release: async () => undefined,
  };
  const runtime = createRuntimeToolService({
    dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
    egressAllowlists: { read: async () => [] },
    builtinExecutors: createRuntimeCodeBuiltinExecutors({
      manager,
      providerName: "aws_lambda_microvm",
      threadSandbox,
    }),
    generateId: async () => id("09"),
    mutationClaims,
    resolveAuthorizationContext: async () => undefined,
    resolveProviderCredential: async () => {
      throw new Error("Provider credentials must not be loaded for built-ins.");
    },
  });
  const request: RuntimeToolBindingRequest = {
    agentDefinitionId: id("01"),
    agentDeploymentId: id("02"),
    agentManifestHash: "sha256:manifest",
    agentReleaseId: id("03"),
    captureMode: "metadata-only",
    effect: "execute",
    environmentId: id("04"),
    idempotencyKey: "model-call-0",
    input: { code: "print('hello')", language: "python" },
    inputSummary: "execute code",
    organizationId: id("05"),
    projectId: id("06"),
    requiredScopes: [],
    runId: id("07"),
    sandboxPolicy: { mode, provider: "aws_lambda_microvm" },
    spanId: "0123456789abcdef",
    threadId: id("08"),
    toolName: "code.execute",
    traceId: "0123456789abcdef0123456789abcdef",
  };
  const run = async () => {
    const decision: RuntimeToolDecision = await runtime.authorizeToolCall(request);
    if (decision.action !== "allow") throw new Error(`Expected allow, got ${decision.action}.`);
    return runtime.executeToolCall({ ...request, decision } as never);
  };
  return { claims, run };
}

describe("sandbox capacity refusals", () => {
  test.each(["run-ephemeral", "thread-persistent"] as const)(
    "complete a %s sandbox tool call with a model-visible limit error",
    async (mode) => {
      const { claims, run } = codeTool(mode);

      expect(await run()).toEqual({
        output: {
          error: { code: "organization_sandbox_limit_reached", limit: 2, message: REFUSAL_MESSAGE },
        },
        outputSummary: `Tool code.execute failed: ${REFUSAL_MESSAGE}`,
        status: "completed",
      });
      expect(claims).toEqual(["begin", "release"]);
    },
  );
});
