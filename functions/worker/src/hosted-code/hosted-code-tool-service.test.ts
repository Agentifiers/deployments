import { describe, expect, test } from "bun:test";
import {
  RuntimeToolExecutionKnownFailureError,
  RuntimeToolPreparationRetryableError,
  type RuntimeToolExecutionResult,
} from "@deployments-ai/agent-runtime";
import {
  AgentReleaseHostedCodeToolRecord,
  ExecutionBindingHostedCodeToolRecord,
  dataBoundaryOf,
  makeUniqueClaimRecord,
  OrganizationDataBoundary,
  ToolAdapterRecord,
  uniqueClaimRequirements,
  UniqueClaimRecord,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import type { SandboxManagerService } from "@deployments-ai/sandbox-hosts";
import { Effect, Schema } from "effect";
import { createDynamoExtensionToolResolver } from "../dynamodb-extension-tools.ts";
import type {
  RuntimeProviderMutationClaim,
  RuntimeProviderMutationClaimStore,
} from "../provider-mutation-claims.ts";
import { createRuntimeToolService } from "../runtime-tool-authorization.ts";
import {
  HOSTED_CODE_EXECUTOR_KEY,
  type RuntimeToolBindingOptions,
} from "../runtime-tool-planning.ts";
import {
  hostedCodeRequest,
  hostedCodeTool,
  ID,
  sandboxRefusingExec,
  scriptedSandbox,
  TOOL_ADAPTER_ID,
  withExecutor,
  type HostedCodeTool,
  type SandboxCall,
} from "./executor.fixture.ts";

const ORDER_TOOL = `export function handler(input) { return { orderId: input.orderId }; }\n`;
const OUTPUT = '{"ok":true,"output":{"orderId":"ord_1"}}';

type ClaimEvent = "begin" | "fail" | "markUnknown" | "release" | "succeed";

function recordingClaims(events: ClaimEvent[]): RuntimeProviderMutationClaimStore {
  let persisted: RuntimeToolExecutionResult | undefined;
  const claim = {} as RuntimeProviderMutationClaim;
  return {
    begin: async () => {
      events.push("begin");
      return persisted ? { action: "replay", result: persisted } : { action: "execute", claim };
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
    succeed: async (_claim, execution) => {
      events.push("succeed");
      persisted = execution;
    },
  };
}

function runtimeFor(
  tool: HostedCodeTool,
  manager: SandboxManagerService,
  options: {
    readonly claims?: RuntimeProviderMutationClaimStore;
    readonly dataBoundaries?: RuntimeToolBindingOptions["dataBoundaries"];
    /** Run identity of the calling run; defaults to a customer deployment run. */
    readonly request?: Readonly<Record<string, unknown>>;
    readonly resolveExtensionToolDefinition?: RuntimeToolBindingOptions["resolveExtensionToolDefinition"];
  } = {},
) {
  const { execute, s3Reads } = withExecutor(tool, { manager });
  const runtime = createRuntimeToolService({
    builtinExecutors: { [HOSTED_CODE_EXECUTOR_KEY]: execute },
    dataBoundaries: options.dataBoundaries ?? { read: async () => dataBoundaryOf(undefined) },
    egressAllowlists: { read: async () => [] },
    generateId: async () => ID,
    ...(options.claims ? { mutationClaims: options.claims } : {}),
    resolveAuthorizationContext: async () => undefined,
    resolveExtensionToolDefinition:
      options.resolveExtensionToolDefinition ??
      (async (toolName) => (toolName === tool.definition.toolName ? tool.definition : undefined)),
    resolveProviderCredential: async () => {
      throw new Error("Provider credentials must not be loaded for hosted code.");
    },
  });
  const call = async (input: Readonly<Record<string, unknown>>) => {
    const request = hostedCodeRequest(input, {
      effect: tool.definition.effect,
      ...options.request,
    });
    const decision = await runtime.authorizeToolCall(request);
    if (decision.action !== "allow") throw new Error(`Expected allow, got ${decision.action}.`);
    return runtime.executeToolCall({ ...request, decision });
  };
  return { call, runtime, s3Reads };
}

describe("hosted code through the runtime tool service", () => {
  test("a phi data boundary refuses hosted code with sandbox network access", async () => {
    const phi = dataBoundaryOf(
      Schema.decodeUnknownSync(OrganizationDataBoundary)({
        operatorNote: "BAA-2026-17",
        profile: "phi",
        setAt: "2026-11-01T00:00:00.000Z",
        setBy: { kind: "operator", principalId: ID },
      }),
    );
    const isolated = hostedCodeTool(ORDER_TOOL);
    const networked = hostedCodeTool(ORDER_TOOL, { execution: { network: "sandbox" } });
    const resolve = (tool: HostedCodeTool) =>
      runtimeFor(
        tool,
        scriptedSandbox([], () => Effect.die("unreachable")),
        {
          dataBoundaries: { read: async () => phi },
        },
      ).runtime.resolveToolDefinition(tool.definition.toolName, hostedCodeRequest({}));

    expect(await resolve(isolated)).toMatchObject({ toolName: isolated.definition.toolName });
    expect(await resolve(networked).catch((cause: unknown) => cause)).toMatchObject({
      code: "tool_outside_data_boundary",
    });
  });

  test("replays a completed mutation claim without running the code again", async () => {
    const calls: SandboxCall[] = [];
    const events: ClaimEvent[] = [];
    const tool = hostedCodeTool(ORDER_TOOL);
    const { call } = runtimeFor(
      tool,
      scriptedSandbox(calls, () =>
        Effect.succeed({ durationMs: 4, exitCode: 0, stderr: "", stdout: OUTPUT }),
      ),
      { claims: recordingClaims(events) },
    );

    const first = await call({ orderId: "ord_1" });
    const replayed = await call({ orderId: "ord_1" });

    expect(calls.filter((entry) => "exec" in entry)).toHaveLength(1);
    expect(events).toEqual(["begin", "succeed", "begin"]);
    expect(replayed.output).toEqual(first.output);
    expect(replayed.outputSummary).toBe(first.outputSummary);
    expect(replayed.artifacts?.map((artifact) => artifact.content)).toEqual(
      first.artifacts?.map((artifact) => artifact.content),
    );
  });

  test("fails the claim deterministically when the sandbox refuses network isolation", async () => {
    const calls: SandboxCall[] = [];
    const events: ClaimEvent[] = [];
    const { call } = runtimeFor(hostedCodeTool(ORDER_TOOL), sandboxRefusingExec(422, calls), {
      claims: recordingClaims(events),
    });

    expect(call({ orderId: "ord_1" })).rejects.toBeInstanceOf(
      RuntimeToolExecutionKnownFailureError,
    );
    expect(events).toEqual(["begin", "fail"]);
  });

  test("fails the claim deterministically when output violates the pinned schema", async () => {
    const events: ClaimEvent[] = [];
    const tool = hostedCodeTool(ORDER_TOOL, {
      outputSchema: { properties: { orderId: { type: "number" } }, type: "object" },
    });
    const { call } = runtimeFor(
      tool,
      scriptedSandbox([], () =>
        Effect.succeed({ durationMs: 4, exitCode: 0, stderr: "", stdout: OUTPUT }),
      ),
      { claims: recordingClaims(events) },
    );

    expect(call({ orderId: "ord_1" })).rejects.toBeInstanceOf(
      RuntimeToolExecutionKnownFailureError,
    );
    expect(events).toEqual(["begin", "fail"]);
  });

  test("retries an unknown exec outcome for read tools and marks mutation outcomes unknown", async () => {
    const read = runtimeFor(
      hostedCodeTool(ORDER_TOOL, { effect: "read" }),
      sandboxRefusingExec(503),
    );
    expect(read.call({ orderId: "ord_1" })).rejects.toBeInstanceOf(
      RuntimeToolPreparationRetryableError,
    );

    const events: ClaimEvent[] = [];
    const execute = runtimeFor(hostedCodeTool(ORDER_TOOL), sandboxRefusingExec(503), {
      claims: recordingClaims(events),
    });
    const rejection = await execute.call({ orderId: "ord_1" }).catch((cause: unknown) => cause);
    expect(rejection).not.toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
    expect(rejection).not.toBeInstanceOf(RuntimeToolPreparationRetryableError);
    expect(events).toEqual(["begin", "markUnknown"]);
  });

  test("executes the release pin even after the live extension moved to other code", async () => {
    const { resolve, result, s3Reads, calls } = await executePinned([releasePin()]);

    expectPinnedExecution(result, s3Reads, calls);
    expect(
      resolve(PINNED.definition.toolName, { environmentId: ID, organizationId: ID, projectId: ID }),
    ).resolves.toBeUndefined();
  });

  test("a manifest-bound run executes its binding pin, never the live extension", async () => {
    const { resolve, result, s3Reads, calls } = await executePinned(
      [bindingPin(new Date(Date.now() + 60 * 60 * 1_000))],
      MANIFEST_BOUND_RUN,
    );

    expectPinnedExecution(result, s3Reads, calls);
    expect(
      resolve(PINNED.definition.toolName, {
        environmentId: ID,
        executionBindingId: OTHER_BINDING_ID,
        organizationId: ID,
        projectId: ID,
      }),
    ).resolves.toBeUndefined();
  });

  test("a manifest-bound run cannot use an expired binding pin", async () => {
    const resolve = createDynamoExtensionToolResolver(
      pinnedDatabase([bindingPin(new Date(Date.now() - 1_000))]),
    );

    expect(
      resolve(PINNED.definition.toolName, {
        environmentId: ID,
        executionBindingId: BINDING_ID,
        organizationId: ID,
        projectId: ID,
      }),
    ).resolves.toBeUndefined();
  });

  test("a release-bound run executes its release's pin", async () => {
    const { result, s3Reads, calls } = await executePinned([releasePin()], {
      ...MANIFEST_BOUND_RUN,
      agentDefinitionId: ID,
      agentReleaseId: ID,
    });

    expectPinnedExecution(result, s3Reads, calls);
  });
});

const BINDING_ID = "01ARZ3NDEKTSV4RRFFQ69G5FC1" as Ulid;
const OTHER_BINDING_ID = "01ARZ3NDEKTSV4RRFFQ69G5FC2" as Ulid;
const PINNED = hostedCodeTool(ORDER_TOOL, { execution: { timeoutMs: 4_000 } });
const MANIFEST_BOUND_RUN = {
  agentDefinitionId: undefined,
  agentDeploymentId: undefined,
  agentReleaseId: undefined,
  executionBindingId: BINDING_ID,
  executionPurpose: "preview",
};

/** Pinned contract: the live adapter below has moved to other code, limits, and network. */
function pinFields() {
  return {
    artifact: PINNED.definition.execution.artifact,
    contentHash: PINNED.definition.execution.contentHash,
    createdAt: "2026-07-26T12:00:00.000Z",
    effect: "execute",
    entrypoint: "handler",
    environmentId: ID,
    inputSchema: PINNED.definition.inputSchema,
    language: "javascript",
    memoryMiB: 256,
    network: "none",
    organizationId: ID,
    outputSchema: { properties: { orderId: { type: "string" } }, type: "object" },
    projectId: ID,
    secretNames: [],
    sourceLanguage: "typescript",
    timeoutMs: 4_000,
    toolAdapterId: TOOL_ADAPTER_ID,
    toolAdapterVersion: 1,
    toolName: PINNED.definition.toolName,
    version: 0,
  };
}

function releasePin() {
  return Schema.decodeUnknownSync(AgentReleaseHostedCodeToolRecord)(
    withCanonicalRecordKeys({
      data: { ...pinFields(), agentReleaseId: ID },
      itemType: "agent-release-hosted-code-tool",
    }),
  );
}

function bindingPin(expiresAt: Date) {
  return Schema.decodeUnknownSync(ExecutionBindingHostedCodeToolRecord)(
    withCanonicalRecordKeys({
      data: {
        ...pinFields(),
        executionBindingId: BINDING_ID,
        expiresAt: expiresAt.toISOString(),
      },
      itemType: "execution-binding-hosted-code-tool",
      ttl: Math.floor(expiresAt.getTime() / 1_000),
    }),
  );
}

function pinnedDatabase(pins: readonly PlatformRecord[]) {
  const live = hostedCodeTool(`export function handler() { return { rewritten: true }; }\n`);
  const liveAdapter = Schema.decodeUnknownSync(ToolAdapterRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: "2026-07-26T12:00:00.000Z",
        defaultPolicyAction: "allow",
        description: "Look up an order.",
        effect: "execute",
        environmentId: ID,
        execution: { ...live.definition.execution, network: "sandbox", timeoutMs: 30_000 },
        id: TOOL_ADAPTER_ID,
        inputSchema: { type: "object" },
        name: PINNED.definition.toolName,
        organizationId: ID,
        outputSchema: { type: "object" },
        projectId: ID,
        requiredScopes: [],
        status: "active",
        updatedAt: "2026-07-27T12:00:00.000Z",
        version: 4,
      },
      itemType: "tool-adapter",
    }),
  );
  const records: PlatformRecord[] = [
    liveAdapter,
    ...pins,
    ...uniqueClaimRequirements(liveAdapter).map((requirement) =>
      Schema.decodeUnknownSync(UniqueClaimRecord)(
        makeUniqueClaimRecord(requirement, liveAdapter.data.createdAt),
      ),
    ),
  ];
  return {
    getRecord: async (_table: string, key: { readonly pk: string; readonly sk: string }) =>
      records.find((record) => record.pk === key.pk && record.sk === key.sk),
  } as unknown as DynamoDatabaseService;
}

/** Runs the pinned tool through the real extension resolver with the calling run's identity. */
async function executePinned(
  pins: readonly PlatformRecord[],
  request: Readonly<Record<string, unknown>> = {},
) {
  const resolve = createDynamoExtensionToolResolver(pinnedDatabase(pins));
  const calls: SandboxCall[] = [];
  const { call, s3Reads } = runtimeFor(
    PINNED,
    scriptedSandbox(calls, () =>
      Effect.succeed({ durationMs: 4, exitCode: 0, stderr: "", stdout: OUTPUT }),
    ),
    { claims: recordingClaims([]), request, resolveExtensionToolDefinition: resolve },
  );
  const result = await call({ orderId: "ord_1" });
  return { calls, resolve, result, s3Reads };
}

function expectPinnedExecution(
  result: RuntimeToolExecutionResult,
  s3Reads: readonly unknown[],
  calls: readonly SandboxCall[],
) {
  expect(result.output).toMatchObject({ exitCode: 0, output: { orderId: "ord_1" } });
  expect(s3Reads).toEqual([
    expect.objectContaining({ VersionId: PINNED.definition.execution.artifact.versionId }),
  ]);
  const upload = calls.find(
    (entry): entry is Extract<SandboxCall, { readonly upload: unknown }> =>
      "upload" in entry && entry.upload.path.endsWith("/tool.mjs"),
  );
  expect(upload?.upload.content).toEqual(PINNED.bytes);
  expect(calls.find((entry) => "exec" in entry)).toMatchObject({
    exec: { network: "none", timeoutMs: 4_000 },
  });
}
