import { describe, expect, test } from "bun:test";
import {
  RuntimeToolPreparationRetryableError,
  type RuntimeToolExecutionResult,
} from "@deployments-ai/agent-runtime";
import { BROWSER_SESSION_EXECUTE_TOOL_NAME } from "@deployments-ai/browser-screenshot";
import {
  ALLOWED_ORIGIN,
  browserExecutors,
  fakeS3,
  fakeSandbox,
  planArtifact,
  request,
  sandboxPolicy,
  type FakeSandbox,
} from "./browser-runtime-tools.fixture.ts";
import type {
  RuntimeProviderMutationClaim,
  RuntimeProviderMutationClaimStore,
} from "./provider-mutation-claims.ts";
import { createRuntimeToolService } from "./runtime-tool-authorization.ts";
import { dataBoundaryOf } from "@deployments-ai/db";

const COLD_START_FAILURE = {
  code: "internal",
  message:
    "Browser job failed: ProtocolError: Target.setDiscoverTargets timed out. Increase the 'protocolTimeout' setting in launch/connect calls for a higher timeout if needed.",
  state: "failed",
};

const { decision: _decision, ...bindingRequest } = request;

const captureRequest = {
  ...bindingRequest,
  input: { url: `${ALLOWED_ORIGIN}/page` },
  sandboxPolicy: sandboxPolicy("run-ephemeral"),
  toolName: "browser.capture_screenshot",
};

const sessionRequest = {
  ...bindingRequest,
  effect: "write" as const,
  input: {
    actions: [{ selector: "#complete", type: "click" }],
    sessionPlanId: request.decision.toolCallId,
    url: `${ALLOWED_ORIGIN}/page`,
  },
  sandboxPolicy: sandboxPolicy("run-ephemeral"),
  toolName: BROWSER_SESSION_EXECUTE_TOOL_NAME,
};

/** The runtime tool service the worker runs browser tools through, over a fake MicroVM. */
function browserTools(sandbox: FakeSandbox) {
  const claimEvents: string[] = [];
  let persisted: RuntimeToolExecutionResult | undefined;
  const mutationClaims: RuntimeProviderMutationClaimStore = {
    begin: async () => {
      claimEvents.push("begin");
      return persisted
        ? { action: "replay", result: persisted }
        : { action: "execute", claim: {} as RuntimeProviderMutationClaim };
    },
    fail: async () => void claimEvents.push("fail"),
    markUnknown: async () => void claimEvents.push("unknown"),
    release: async () => void claimEvents.push("release"),
    succeed: async (_claim, result) => {
      claimEvents.push("succeed");
      persisted = result;
    },
  };
  const service = createRuntimeToolService({
    dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
    egressAllowlists: { read: async () => [] },
    builtinExecutors: browserExecutors({
      artifactS3: fakeS3().client,
      manager: sandbox.manager,
      records: [planArtifact({})],
      threadSandbox: sandbox.threadSandbox,
    }),
    generateId: async () => request.decision.toolCallId,
    mutationClaims,
    resolveAuthorizationContext: async () => undefined,
    resolveProviderCredential: async () => {
      throw new Error("Provider credentials must not be loaded for built-ins.");
    },
  });
  const execute = async (toolRequest: typeof captureRequest | typeof sessionRequest) => {
    const decision = await service.authorizeToolCall(toolRequest);
    if (decision.action === "deny") throw new Error(`Denied: ${decision.reason}`);
    const { approvalId: _approvalId, ...approved } = decision;
    return service.executeToolCall({ ...toolRequest, decision: { ...approved, action: "allow" } });
  };
  const jobStarts = () => sandbox.calls.commands.filter((command) => command[2] === "start").length;
  return { claimEvents, execute, jobStarts };
}

const failedResult = (toolName: string) => ({
  output: { error: { code: COLD_START_FAILURE.code, message: COLD_START_FAILURE.message } },
  outputSummary: `Tool ${toolName} failed: ${COLD_START_FAILURE.message}`,
  status: "completed" as const,
});

describe("browser jobs through the runtime tool service", () => {
  test("a capture that failed inside the MicroVM is a failed tool result, not a requeue", async () => {
    const tools = browserTools(fakeSandbox({ status: COLD_START_FAILURE }));

    expect(await tools.execute(captureRequest)).toEqual(failedResult("browser.capture_screenshot"));
    expect(tools.jobStarts()).toBe(1);
  });

  test("a capture whose job never started still requeues the run", async () => {
    const tools = browserTools(fakeSandbox({ uploadFails: true }));

    const failure = await tools.execute(captureRequest).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(RuntimeToolPreparationRetryableError);
    expect(tools.jobStarts()).toBe(0);
  });

  test("a session that failed inside the MicroVM is a failed result that replays without rerunning", async () => {
    const tools = browserTools(fakeSandbox({ status: COLD_START_FAILURE }));

    expect(await tools.execute(sessionRequest)).toEqual(
      failedResult(BROWSER_SESSION_EXECUTE_TOOL_NAME),
    );
    expect(await tools.execute(sessionRequest)).toEqual(
      failedResult(BROWSER_SESSION_EXECUTE_TOOL_NAME),
    );
    expect(tools.claimEvents).toEqual(["begin", "succeed", "begin"]);
    expect(tools.jobStarts()).toBe(1);
  });

  test("a session whose job never started requeues the run and releases its claim", async () => {
    const tools = browserTools(fakeSandbox({ uploadFails: true }));

    const failure = await tools.execute(sessionRequest).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(RuntimeToolPreparationRetryableError);
    expect(tools.claimEvents).toEqual(["begin", "release"]);
    expect(tools.jobStarts()).toBe(0);
  });
});
