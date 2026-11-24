import { describe, expect, test } from "bun:test";
import {
  RuntimeToolExecutionKnownFailureError,
  type RuntimeToolExecutionResult,
} from "@deployments-ai/agent-runtime";
import { RemoteMcpError, type RemoteMcpToolCall } from "@deployments-ai/mcp-client";
import { createDynamoRuntimeVendorMcp } from "./dynamodb-runtime-vendor-mcp.ts";
import {
  RuntimeProviderMutationOutcomeUnknownError,
  type RuntimeProviderMutationClaim,
  type RuntimeProviderMutationClaimInput,
  type RuntimeProviderMutationClaimStore,
} from "./provider-mutation-claims.ts";
import { createRuntimeToolService, executionPlan } from "./runtime-tools.ts";
import {
  bindingRecords,
  bindingRequest,
  ids,
  memoryDatabase,
  NOW,
  secretDocument,
  TOOL_HASH,
  vendorAdapter,
  vendorRegistry,
} from "./vendor-mcp-runtime.fixture.ts";
import { dataBoundaryOf } from "@deployments-ai/db";

const updatePage = vendorAdapter({
  effect: "write",
  name: "notion.notion_update_page",
  remoteToolName: "notion-update-page",
});

type ClaimEvent = "begin" | "fail" | "markUnknown" | "release" | "succeed";

function harness(options: {
  readonly callTool?: (input: RemoteMcpToolCall) => Promise<unknown>;
  readonly replay?: RuntimeToolExecutionResult;
}) {
  const seeded = bindingRecords({ providerKey: "notion", toolNames: [updatePage.toolName] });
  const { database } = memoryDatabase(Object.values(seeded));
  const calls: RemoteMcpToolCall[] = [];
  const events: ClaimEvent[] = [];
  const begun: RuntimeProviderMutationClaimInput[] = [];
  const succeeded: RuntimeToolExecutionResult[] = [];
  const claims: RuntimeProviderMutationClaimStore = {
    begin: async (input) => {
      events.push("begin");
      begun.push(input);
      return options.replay
        ? { action: "replay", result: options.replay }
        : { action: "execute", claim: { input, record: {} } as RuntimeProviderMutationClaim };
    },
    fail: async () => {
      events.push("fail");
    },
    markUnknown: async () => {
      events.push("markUnknown");
    },
    release: async () => {
      events.push("release");
    },
    succeed: async (_claim, result) => {
      events.push("succeed");
      succeeded.push(result);
    },
  };
  let nextId = 0;
  const vendor = createDynamoRuntimeVendorMcp({
    client: {
      callTool: async (input) => {
        calls.push(input);
        if (options.callTool) return (await options.callTool(input)) as never;
        input.onToolCallDispatch?.();
        return { isError: false, result: { content: [{ text: "Page updated", type: "text" }] } };
      },
    },
    database,
    now: () => NOW,
    providerRegistry: vendorRegistry,
    readCredential: async (input) =>
      secretDocument({ accessToken: "notion-access-token" }, input.reference.generation),
  });
  const service = createRuntimeToolService({
    dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
    egressAllowlists: { read: async () => [] },
    ...vendor,
    generateId: async () => ids[16 + (nextId++ % 6)]!,
    mutationClaims: claims,
    resolveAuthorizationContext: async () => {
      throw new Error("vendor MCP tools must not resolve provider-native authorization");
    },
    resolveExtensionToolDefinition: async (toolName) =>
      toolName === updatePage.toolName ? updatePage : undefined,
    resolveProviderCredential: async () => {
      throw new Error("vendor MCP tools must not read provider-native credentials");
    },
  });
  const approvedExecution = async () => {
    const request = bindingRequest(updatePage, { query: "Q4 plan" });
    const decision = await service.authorizeToolCall(request);
    if (decision.action !== "require-approval" || !decision.executionBinding) {
      throw new Error("writes require approval");
    }
    return service.executeToolCall({
      ...request,
      approvalId: decision.approvalId,
      decision: {
        action: "allow",
        executionBinding: decision.executionBinding,
        reason: decision.reason,
        toolCallId: decision.toolCallId,
      },
      policyAction: "require-approval",
    });
  };
  return { approvedExecution, begun, calls, events, service, succeeded };
}

describe("vendor MCP mutations", () => {
  test("plans vendor writes as mcp-mutation pinned to the remote tool and hash", () => {
    const plan = executionPlan(updatePage, undefined);
    expect(plan).toMatchObject({
      effect: "write",
      kind: "mcp-mutation",
      mcpToolName: "notion-update-page",
      vendor: { providerKey: "notion", toolHash: TOOL_HASH },
    });
    if (updatePage.execution?.type !== "vendor_mcp") throw new Error("not a vendor tool");
    const changed = executionPlan(
      {
        ...updatePage,
        execution: { ...updatePage.execution, toolHash: `sha256:${"b".repeat(64)}` },
      },
      undefined,
    );
    expect(changed.fingerprint).not.toBe(plan.fingerprint);
  });

  test("claims the logical idempotency key before dispatch and records success", async () => {
    const { approvedExecution, begun, calls, events, succeeded } = harness({});

    const result = await approvedExecution();

    expect(events).toEqual(["begin", "succeed"]);
    expect(begun[0]).toMatchObject({ effect: "write", idempotencyKey: "tool-call-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      arguments: { query: "Q4 plan", workspace: "acme" },
      expectedToolHash: TOOL_HASH,
      toolName: "notion-update-page",
    });
    expect(result.outputSummary).toBe("Page updated");
    expect(succeeded).toEqual([result]);
  });

  test("replays a settled claim without contacting the vendor", async () => {
    const stored: RuntimeToolExecutionResult = { outputSummary: "stored", status: "completed" };
    const { approvedExecution, calls, events } = harness({ replay: stored });
    expect(approvedExecution()).resolves.toEqual(stored);
    expect(calls).toHaveLength(0);
    expect(events).toEqual(["begin"]);
  });

  test("quarantines an ambiguous failure after tools/call was sent", async () => {
    const { approvedExecution, events } = harness({
      callTool: async (input) => {
        input.onToolCallDispatch?.();
        throw new RemoteMcpError("timeout", "MCP call exceeded 60000 ms.");
      },
    });
    expect(approvedExecution()).rejects.toBeInstanceOf(RuntimeProviderMutationOutcomeUnknownError);
    expect(events).toEqual(["begin", "markUnknown"]);
  });

  test("fails the claim for a deterministic failure before dispatch", async () => {
    const { approvedExecution, events } = harness({
      callTool: async () => {
        throw new RemoteMcpError("tool-drift", "changed");
      },
    });
    expect(approvedExecution()).rejects.toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
    expect(events).toEqual(["begin", "fail"]);
  });

  test("releases the claim for a transient failure before dispatch", async () => {
    const { approvedExecution, events } = harness({
      callTool: async () => {
        throw new RemoteMcpError("transport", "Remote MCP transport failed.");
      },
    });
    expect(approvedExecution()).rejects.toThrow();
    expect(events).toEqual(["begin", "release"]);
  });

  test("quarantines a dispatched write whose result is rejected after tools/call", async () => {
    const { approvedExecution, calls, events } = harness({
      callTool: async (input) => {
        input.onToolCallDispatch?.();
        return { isError: false, result: { content: [{ text: "token notion-access-token" }] } };
      },
    });
    expect(approvedExecution()).rejects.toBeInstanceOf(RuntimeProviderMutationOutcomeUnknownError);
    expect(events).toEqual(["begin", "markUnknown"]);
    expect(calls).toHaveLength(1);
  });

  test("refuses execution without policy provenance before claiming", async () => {
    const { begun, calls, service } = harness({});
    const request = bindingRequest(updatePage, { query: "Q4 plan" });
    const decision = await service.authorizeToolCall(request);
    if (decision.action !== "require-approval" || !decision.executionBinding) {
      throw new Error("writes require approval");
    }
    expect(
      service.executeToolCall({
        ...request,
        decision: {
          action: "allow",
          executionBinding: decision.executionBinding,
          reason: decision.reason,
          toolCallId: decision.toolCallId,
        },
      }),
    ).rejects.toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
    expect(begun).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});
