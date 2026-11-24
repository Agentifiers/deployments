import { describe, expect, test } from "bun:test";
import type { RuntimeToolExecutionResult } from "@deployments-ai/agent-runtime";
import {
  dataBoundaryOf,
  OrganizationDataBoundary,
  type DataBoundary,
  type OrganizationDataBoundaryReader,
  type Ulid,
} from "@deployments-ai/db";
import type { ToolAdapterDefinition } from "@deployments-ai/tools";
import type {
  RuntimeProviderMutationClaim,
  RuntimeProviderMutationClaimStore,
} from "./provider-mutation-claims.ts";
import { RuntimeProviderMutationIdentityConflictError } from "./provider-mutation-claims.ts";
import {
  RuntimeToolExecutionKnownFailureError,
  RuntimeToolPreparationRetryableError,
} from "@deployments-ai/agent-runtime";
import { Schema } from "effect";
import { createRuntimeToolService } from "./runtime-tool-authorization.ts";
import { ToolOutsideDataBoundaryError } from "./runtime-tool-call-authorization.ts";
import type { ExecuteRuntimeBuiltinTool } from "./runtime-tools.ts";

const id = (suffix: string) => `01J000000000000000000000${suffix}` as Ulid;
const baseRequest = {
  agentDefinitionId: id("01"),
  agentDeploymentId: id("02"),
  agentReleaseId: id("03"),
  environmentId: id("04"),
  idempotencyKey: "builtin-mutation",
  inputSummary: "test",
  organizationId: id("05"),
  projectId: id("06"),
  requiredScopes: [],
  runId: id("07"),
  threadId: id("08"),
};

function service(options: {
  readonly claims?: RuntimeProviderMutationClaimStore;
  readonly dataBoundaries?: OrganizationDataBoundaryReader;
  readonly executors: Readonly<Record<string, () => Promise<RuntimeToolExecutionResult>>>;
  readonly isToolAvailable?: (toolName: string) => boolean;
  readonly resolveExtensionToolDefinition?: (
    toolName: string,
  ) => Promise<ToolAdapterDefinition | undefined>;
}) {
  return createRuntimeToolService({
    builtinExecutors: options.executors,
    dataBoundaries: options.dataBoundaries ?? { read: async () => dataBoundaryOf(undefined) },
    egressAllowlists: { read: async () => [] },
    generateId: async () => id("09"),
    ...(options.isToolAvailable ? { isToolAvailable: options.isToolAvailable } : {}),
    ...(options.resolveExtensionToolDefinition
      ? { resolveExtensionToolDefinition: options.resolveExtensionToolDefinition }
      : {}),
    ...(options.claims ? { mutationClaims: options.claims } : {}),
    resolveAuthorizationContext: async () => undefined,
    resolveProviderCredential: async () => {
      throw new Error("Provider credentials must not be loaded for built-ins.");
    },
  });
}

describe("built-in mutation claims", () => {
  test("does not advertise or authorize a deployment-disabled built-in", async () => {
    const runtime = service({
      executors: { "web.scrape": async () => ({ status: "completed" }) },
      isToolAvailable: (toolName) => toolName !== "web.scrape",
    });

    expect(await runtime.resolveToolDefinition("web.scrape", baseRequest)).toBeUndefined();
    expect(
      runtime.authorizeToolCall({ ...baseRequest, effect: "read", toolName: "web.scrape" }),
    ).resolves.toMatchObject({ action: "deny" });
  });

  test("does not apply platform family feature flags to same-prefix extension tools", async () => {
    const extension = {
      defaultPolicyAction: "allow",
      description: "Search a tenant-specific index.",
      effect: "read",
      execution: {
        authorizationHeader: "Bearer extension-test",
        completionMode: "sync",
        endpointOrigin: "https://example.com",
        endpointPath: "/search",
        type: "http_callback",
      },
      provider: "custom",
      requiredScopes: [],
      status: "active",
      toolAdapterId: id("10"),
      toolName: "web.custom_search",
    } as const satisfies ToolAdapterDefinition;
    const runtime = service({
      executors: {},
      isToolAvailable: (toolName) => !toolName.startsWith("web."),
      resolveExtensionToolDefinition: async (toolName) =>
        toolName === extension.toolName ? extension : undefined,
    });

    expect(runtime.resolveToolDefinition(extension.toolName, baseRequest)).resolves.toMatchObject({
      toolName: extension.toolName,
    });
  });

  test("replays a durable built-in mutation without invoking it twice", async () => {
    const result: RuntimeToolExecutionResult = {
      outputSummary: "delegated",
      status: "completed",
      transientArtifacts: [
        { content: "ephemeral", fileName: "access.json", label: "Ephemeral access" },
      ],
    };
    const durableResult: RuntimeToolExecutionResult = {
      outputSummary: "delegated",
      status: "completed",
    };
    const claim = {} as RuntimeProviderMutationClaim;
    let persisted: RuntimeToolExecutionResult | undefined;
    let executions = 0;
    let begins = 0;
    const claimKeys: string[] = [];
    const claims: RuntimeProviderMutationClaimStore = {
      begin: async (input) => {
        begins += 1;
        claimKeys.push(input.idempotencyKey);
        return persisted ? { action: "replay", result: persisted } : { action: "execute", claim };
      },
      fail: async () => undefined,
      markUnknown: async () => undefined,
      release: async () => undefined,
      succeed: async (_claim, execution) => {
        persisted = execution;
      },
    };
    const runtime = service({
      claims,
      executors: {
        "agent.delegate": async () => {
          executions += 1;
          return result;
        },
      },
    });
    const authorized = await runtime.authorizeToolCall({
      ...baseRequest,
      effect: "execute",
      toolName: "agent.delegate",
    });
    expect(authorized.action).toBe("allow");
    if (authorized.action !== "allow") throw new Error("Expected an allowed built-in.");
    const executionRequest = {
      ...baseRequest,
      decision: authorized,
      effect: "execute" as const,
      input: { idempotencyKey: "caller-stable-delegation" },
      toolName: "agent.delegate",
    };
    expect(await runtime.executeToolCall(executionRequest)).toEqual(result);
    expect(
      await runtime.executeToolCall({
        ...executionRequest,
        idempotencyKey: "different-model-call-index",
      }),
    ).toEqual(durableResult);
    expect({ begins, executions }).toEqual({ begins: 2, executions: 1 });
    expect(persisted).toEqual(durableResult);
    expect(claimKeys[0]).toBe(claimKeys[1]);
  });

  test("refreshes ephemeral output when replaying a durable built-in mutation", async () => {
    const claim = {} as RuntimeProviderMutationClaim;
    const stale: RuntimeToolExecutionResult = {
      artifacts: [{ content: "stale", fileName: "share.json", label: "Shared artifact" }],
      status: "completed",
    };
    const fresh: RuntimeToolExecutionResult = {
      ...stale,
      status: "completed",
      transientArtifacts: [
        { content: "fresh", fileName: "access.json", label: "Ephemeral access" },
      ],
    };
    let persisted: RuntimeToolExecutionResult | undefined;
    let executions = 0;
    let refreshes = 0;
    const claims: RuntimeProviderMutationClaimStore = {
      begin: async () =>
        persisted ? { action: "replay", result: persisted } : { action: "execute", claim },
      fail: async () => undefined,
      markUnknown: async () => undefined,
      release: async () => undefined,
      succeed: async (_claim, execution) => {
        persisted = execution;
      },
    };
    const executor = Object.assign(
      async () => {
        executions += 1;
        return stale;
      },
      {
        refreshReplay: async () => {
          refreshes += 1;
          return fresh;
        },
      },
    ) satisfies ExecuteRuntimeBuiltinTool;
    const runtime = service({ claims, executors: { "agent.delegate": executor } });
    const authorized = await runtime.authorizeToolCall({
      ...baseRequest,
      effect: "execute",
      toolName: "agent.delegate",
    });
    if (authorized.action !== "allow") throw new Error("Expected an allowed built-in.");
    const request = {
      ...baseRequest,
      decision: authorized,
      effect: "execute" as const,
      toolName: "agent.delegate",
    };
    expect(await runtime.executeToolCall(request)).toEqual(stale);
    expect(await runtime.executeToolCall(request)).toEqual(fresh);
    expect({ executions, refreshes }).toEqual({ executions: 1, refreshes: 1 });
  });

  test("persists a compact mutation claim and idempotently refreshes large evidence", async () => {
    const claim = {} as RuntimeProviderMutationClaim;
    const fullResult: RuntimeToolExecutionResult = {
      artifacts: [
        {
          content: "rendered".repeat(100_000),
          fileName: "browser-session.html",
          label: "Rendered DOM",
        },
      ],
      outputSummary: "Captured browser evidence.",
      status: "completed",
    };
    let persisted: RuntimeToolExecutionResult | undefined;
    let executions = 0;
    let refreshes = 0;
    const claims: RuntimeProviderMutationClaimStore = {
      begin: async () =>
        persisted ? { action: "replay", result: persisted } : { action: "execute", claim },
      fail: async () => undefined,
      markUnknown: async () => undefined,
      release: async () => undefined,
      succeed: async (_claim, result) => {
        persisted = result;
      },
    };
    const executor = Object.assign(
      async () => {
        executions += 1;
        return fullResult;
      },
      {
        mutationClaimResult: (result: RuntimeToolExecutionResult) => ({
          artifacts: [],
          ...(result.outputSummary ? { outputSummary: result.outputSummary } : {}),
          status: result.status,
        }),
        refreshReplay: async () => {
          refreshes += 1;
          return fullResult;
        },
      },
    ) satisfies ExecuteRuntimeBuiltinTool;
    const runtime = service({ claims, executors: { "agent.delegate": executor } });
    const authorized = await runtime.authorizeToolCall({
      ...baseRequest,
      effect: "execute",
      toolName: "agent.delegate",
    });
    if (authorized.action !== "allow") throw new Error("Expected an allowed built-in.");
    const executionRequest = {
      ...baseRequest,
      decision: authorized,
      effect: "execute" as const,
      toolName: "agent.delegate",
    };

    expect(await runtime.executeToolCall(executionRequest)).toEqual(fullResult);
    expect(persisted).toEqual({
      artifacts: [],
      outputSummary: "Captured browser evidence.",
      status: "completed",
    });
    expect(await runtime.executeToolCall(executionRequest)).toEqual(fullResult);
    expect({ executions, refreshes }).toEqual({ executions: 1, refreshes: 1 });
  });

  test("does not force deterministic artifact builders into bounded claim storage", async () => {
    let claimBegins = 0;
    const claims: RuntimeProviderMutationClaimStore = {
      begin: async () => {
        claimBegins += 1;
        throw new Error("Artifact builders must not acquire provider mutation claims.");
      },
      fail: async () => undefined,
      markUnknown: async () => undefined,
      release: async () => undefined,
      succeed: async () => undefined,
    };
    const output = "x".repeat(350_000);
    const runtime = service({
      claims,
      executors: {
        "artifact.spreadsheet_export": async () => ({
          artifacts: [
            { content: output, fileName: "large.csv", label: "Large export", type: "report" },
          ],
          status: "completed",
        }),
      },
    });
    const authorized = await runtime.authorizeToolCall({
      ...baseRequest,
      effect: "write",
      toolName: "artifact.spreadsheet_export",
    });
    expect(authorized.action).toBe("allow");
    if (authorized.action !== "allow") throw new Error("Expected an allowed built-in.");
    const result = await runtime.executeToolCall({
      ...baseRequest,
      decision: authorized,
      effect: "write",
      toolName: "artifact.spreadsheet_export",
    });
    expect(String(result.artifacts?.[0]?.content)).toHaveLength(350_000);
    expect(claimBegins).toBe(0);
  });

  test("treats caller idempotency identity conflicts as terminal", async () => {
    const claims: RuntimeProviderMutationClaimStore = {
      begin: async () => {
        throw new RuntimeProviderMutationIdentityConflictError("agent.delegate");
      },
      fail: async () => undefined,
      markUnknown: async () => undefined,
      release: async () => undefined,
      succeed: async () => undefined,
    };
    const runtime = service({
      claims,
      executors: { "agent.delegate": async () => ({ status: "completed" }) },
    });
    const authorized = await runtime.authorizeToolCall({
      ...baseRequest,
      effect: "execute",
      toolName: "agent.delegate",
    });
    if (authorized.action !== "allow") throw new Error("Expected an allowed built-in.");
    expect(
      runtime.executeToolCall({
        ...baseRequest,
        decision: authorized,
        effect: "execute",
        toolName: "agent.delegate",
      }),
    ).rejects.toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
  });

  test("fails closed when durable claims are unavailable", async () => {
    let executions = 0;
    const runtime = service({
      executors: {
        "agent.delegate": async () => {
          executions += 1;
          return { status: "completed" };
        },
      },
    });
    const authorized = await runtime.authorizeToolCall({
      ...baseRequest,
      effect: "execute",
      toolName: "agent.delegate",
    });
    if (authorized.action !== "allow") throw new Error("Expected an allowed built-in.");
    expect(
      runtime.executeToolCall({
        ...baseRequest,
        decision: authorized,
        effect: "execute",
        toolName: "agent.delegate",
      }),
    ).rejects.toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
    expect(executions).toBe(0);
  });
});

describe("organization data boundary", () => {
  const phi = dataBoundaryOf(
    Schema.decodeUnknownSync(OrganizationDataBoundary)({
      operatorNote: "BAA-2026-17",
      profile: "phi",
      setAt: "2026-11-01T00:00:00.000Z",
      setBy: { kind: "operator", principalId: id("11") },
    }),
  );
  const PUBLIC_REFUSAL =
    "Tool code.execute can reach public destinations, which this organization's phi data boundary does not allow.";

  function boundaryReader(initial: DataBoundary) {
    const reader = { current: initial, reads: [] as Ulid[] };
    return {
      reader,
      dataBoundaries: {
        read: async (organizationId: Ulid) => {
          reader.reads.push(organizationId);
          return reader.current;
        },
      } satisfies OrganizationDataBoundaryReader,
    };
  }

  test("refuses to resolve or authorize a tool whose destinations its input cannot name", async () => {
    const { dataBoundaries, reader } = boundaryReader(phi);
    const runtime = service({
      dataBoundaries,
      executors: { "code.execute": async () => ({ status: "completed" }) },
    });

    const resolved = await runtime.resolveToolDefinition("code.execute", baseRequest).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(resolved).toBeInstanceOf(ToolOutsideDataBoundaryError);
    expect(resolved).toMatchObject({ code: "tool_outside_data_boundary", message: PUBLIC_REFUSAL });
    expect(
      await runtime.authorizeToolCall({
        ...baseRequest,
        effect: "execute",
        toolName: "code.execute",
      }),
    ).toMatchObject({ action: "deny", reason: PUBLIC_REFUSAL });
    expect(reader.reads).toEqual([baseRequest.organizationId, baseRequest.organizationId]);
  });

  test("fails an authorized code.execute call once the organization gains a phi boundary", async () => {
    const { dataBoundaries, reader } = boundaryReader(dataBoundaryOf(undefined));
    let executions = 0;
    const runtime = service({
      dataBoundaries,
      executors: {
        "code.execute": async () => {
          executions += 1;
          return { status: "completed" };
        },
      },
    });
    const authorized = await runtime.authorizeToolCall({
      ...baseRequest,
      effect: "execute",
      toolName: "code.execute",
    });
    if (authorized.action !== "allow") throw new Error("Expected an allowed built-in.");
    reader.current = phi;

    const failure = await runtime
      .executeToolCall({
        ...baseRequest,
        decision: authorized,
        effect: "execute",
        toolName: "code.execute",
      })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );

    expect(failure).toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
    expect((failure as Error).cause).toMatchObject({ message: PUBLIC_REFUSAL });
    expect(executions).toBe(0);
  });

  test("resolves platform tools without reading the boundary", async () => {
    const { dataBoundaries, reader } = boundaryReader(phi);
    const runtime = service({ dataBoundaries, executors: {} });

    expect(await runtime.resolveToolDefinition("agent.memory.search", baseRequest)).toMatchObject({
      toolName: "agent.memory.search",
    });
    expect(await runtime.resolveToolDefinition("attachment.read", baseRequest)).toMatchObject({
      toolName: "attachment.read",
    });
    expect(reader.reads).toEqual([]);
  });

  test("resolves a public-egress tool for an organization without a boundary", async () => {
    const { dataBoundaries } = boundaryReader(dataBoundaryOf(undefined));
    const runtime = service({ dataBoundaries, executors: {} });

    expect(await runtime.resolveToolDefinition("web.scrape", baseRequest)).toMatchObject({
      toolName: "web.scrape",
    });
  });

  test("fails closed when the boundary cannot be read", async () => {
    const failure = new Error("standing read throttled");
    const runtime = service({
      dataBoundaries: { read: () => Promise.reject(failure) },
      executors: {},
    });

    const rejected = (promise: Promise<unknown>) =>
      promise.then(
        () => undefined,
        (cause: unknown) => cause,
      );

    for (const refusal of [
      await rejected(runtime.resolveToolDefinition("web.scrape", baseRequest)),
      await rejected(
        runtime.authorizeToolCall({ ...baseRequest, effect: "read", toolName: "web.scrape" }),
      ),
    ]) {
      expect(refusal).toBeInstanceOf(RuntimeToolPreparationRetryableError);
      expect((refusal as RuntimeToolPreparationRetryableError).preparationCause).toBe(failure);
    }
  });

  test("retries an authorized call whose boundary read fails at execution", async () => {
    const { dataBoundaries, reader } = boundaryReader(dataBoundaryOf(undefined));
    let executions = 0;
    let readFailure: Error | undefined;
    const runtime = service({
      dataBoundaries: {
        read: (organizationId) =>
          readFailure ? Promise.reject(readFailure) : dataBoundaries.read(organizationId),
      },
      executors: {
        "web.scrape": async () => {
          executions += 1;
          return { status: "completed" };
        },
      },
    });
    const authorized = await runtime.authorizeToolCall({
      ...baseRequest,
      effect: "read",
      toolName: "web.scrape",
    });
    if (authorized.action !== "allow") throw new Error("Expected an allowed built-in.");
    readFailure = new Error("standing read throttled");

    const failure = await runtime
      .executeToolCall({
        ...baseRequest,
        decision: authorized,
        effect: "read",
        toolName: "web.scrape",
      })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );

    expect(failure).toBeInstanceOf(RuntimeToolPreparationRetryableError);
    expect((failure as RuntimeToolPreparationRetryableError).preparationCause).toBe(readFailure);
    expect(reader.reads).toEqual([baseRequest.organizationId]);
    expect(executions).toBe(0);
  });
});
