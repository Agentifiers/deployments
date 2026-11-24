import { describe, expect, test } from "bun:test";

import {
  RuntimeToolExecutionKnownFailureError,
  RuntimeToolPreparationRetryableError,
  type RuntimeSandboxPolicy,
  type RuntimeToolAllowedDecision,
  type RuntimeToolDecision,
  type RuntimeToolExecutionResult,
} from "@deployments-ai/agent-runtime";
import { dataBoundaryOf, type Ulid } from "@deployments-ai/db";
import {
  SandboxCapacityError,
  type ManagedSandbox,
  type SandboxManagerService,
} from "@deployments-ai/sandbox-hosts";
import type {
  ProviderNativeHttpExecutorOptions,
  ToolAdapterDefinition,
} from "@deployments-ai/tools";
import { Effect } from "effect";

import {
  CALLBACK_WORKSPACE_FILES_MAX_CONTENT_BYTES,
  CALLBACK_WORKSPACE_FILES_MAX_FILES,
  createCallbackWorkspaceFileReader,
} from "./callback-workspace-files.ts";
import type {
  RuntimeProviderMutationClaim,
  RuntimeProviderMutationClaimStore,
} from "./provider-mutation-claims.ts";
import type { RuntimeCallbackWorkspaceFile } from "./runtime-http-callback.ts";
import {
  createRuntimeToolDependencies,
  executionPlan,
  type ReadRuntimeCallbackWorkspaceFiles,
  type RuntimeToolBindingRequest,
} from "./runtime-tools.ts";
import type { ThreadSandboxWorkspace } from "./thread-sandbox/contracts.ts";

const ids = {
  agentDefinitionId: "01J00000000000000000000001" as Ulid,
  agentDeploymentId: "01J00000000000000000000002" as Ulid,
  agentReleaseId: "01J00000000000000000000003" as Ulid,
  environmentId: "01J00000000000000000000004" as Ulid,
  organizationId: "01J00000000000000000000005" as Ulid,
  projectId: "01J00000000000000000000006" as Ulid,
  runId: "01J00000000000000000000007" as Ulid,
  threadId: "01J00000000000000000000008" as Ulid,
};
const HTML: RuntimeCallbackWorkspaceFile = {
  byteSize: 15,
  content: "<h1>Hello</h1>\n",
  path: "site/index.html",
  sha256: "a".repeat(64),
};
const LOGO: RuntimeCallbackWorkspaceFile = {
  byteSize: 4,
  path: "site/logo.png",
  sha256: "b".repeat(64),
};

type PinnedRequestInput = Parameters<
  NonNullable<ProviderNativeHttpExecutorOptions["pinnedRequest"]>
>[0];

function publishTool(effect: ToolAdapterDefinition["effect"] = "write"): ToolAdapterDefinition {
  return {
    defaultPolicyAction: "allow",
    description: "Publish the site.",
    effect,
    execution: {
      authorizationHeader: "Bearer callback-secret",
      completionMode: "sync",
      endpointOrigin: "https://callbacks.example.com",
      endpointPath: "/v1/publish",
      type: "http_callback",
      workspaceFiles: { include: ["site/*.html", "site/*.png"] },
    },
    inputSchema: { type: "object" },
    provider: "github",
    requiredScopes: [],
    status: "active",
    toolAdapterId: "01J00000000000000000000025" as Ulid,
    toolName: "site.publish",
  };
}

function harness(
  options: {
    readonly definition?: ToolAdapterDefinition;
    readonly readFiles?: ReadRuntimeCallbackWorkspaceFiles | null;
    readonly replay?: RuntimeToolExecutionResult;
  } = {},
) {
  const definition = options.definition ?? publishTool();
  const calls = {
    callbacks: [] as PinnedRequestInput[],
    claims: [] as string[],
    dispatches: 0,
    reads: [] as unknown[],
  };
  const readFiles: ReadRuntimeCallbackWorkspaceFiles = async (request, spec) => {
    calls.reads.push({ include: spec.include, sandboxPolicy: request.sandboxPolicy });
    return [HTML, LOGO];
  };
  const mutationClaims: RuntimeProviderMutationClaimStore = {
    begin: async (input) => {
      calls.claims.push("begin");
      return options.replay
        ? { action: "replay", result: options.replay }
        : {
            action: "execute",
            claim: { input, record: {} as never } as RuntimeProviderMutationClaim,
          };
    },
    fail: async () => void calls.claims.push("fail"),
    markUnknown: async () => void calls.claims.push("unknown"),
    release: async () => void calls.claims.push("release"),
    succeed: async () => void calls.claims.push("succeed"),
  };
  let nextId = 0x30;
  const dependencies = createRuntimeToolDependencies({
    dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
    egressAllowlists: { read: async () => [] },
    executor: {
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 as const }],
      pinnedRequest: async (callbackRequest) => {
        calls.callbacks.push(callbackRequest);
        return Response.json({ published: true });
      },
    },
    generateId: async () =>
      `01J000000000000000000000${(nextId++).toString(16).toUpperCase()}` as Ulid,
    mutationClaims,
    persistHttpCallbackDispatch: async (callbackRequest, _input, _control, _context, sendable) => {
      sendable(undefined);
      calls.dispatches += 1;
      return { evidenceId: callbackRequest.decision.toolCallId };
    },
    ...(options.readFiles === null
      ? {}
      : { readCallbackWorkspaceFiles: options.readFiles ?? readFiles }),
    resolveAuthorizationContext: async () => ({
      authorizationFingerprint: "sha256:github-account-1:resources-v1",
      connectionId: "01J00000000000000000000019" as Ulid,
      connectorProvider: "github",
      externalAccountId: "github-account-1",
      externalResourceConstraints: {},
      grantedScopes: [],
    }),
    resolveExtensionToolDefinition: async (toolName) =>
      toolName === definition.toolName ? definition : undefined,
    resolveProviderCredential: async () => {
      throw new Error("provider credential should not be used");
    },
  });
  const run = async (mode: RuntimeSandboxPolicy["mode"] = "thread-persistent") => {
    const request: RuntimeToolBindingRequest = {
      ...ids,
      effect: definition.effect,
      idempotencyKey: "publish-1",
      input: { note: "launch" },
      inputSummary: "Publish the site.",
      policyAction: "allow",
      requiredScopes: [],
      sandboxPolicy: { mode, provider: "aws_lambda_microvm" },
      toolName: definition.toolName,
    };
    const decision = allowed(await dependencies.authorizeToolCall(request));
    return dependencies.executeToolCall({ ...request, decision } as never);
  };
  return { calls, run };
}

function allowed(decision: RuntimeToolDecision): RuntimeToolAllowedDecision {
  if (decision.action !== "allow") throw new Error(`Expected allow, got ${decision.action}.`);
  return decision;
}

function knownFailureMessage(cause: unknown) {
  expect(cause).toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
  const inner = (cause as RuntimeToolExecutionKnownFailureError).executionCause;
  return inner instanceof Error ? inner.message : String(inner);
}

describe("HTTP callback plan fingerprints", () => {
  test("change when the workspace file patterns change", () => {
    const fingerprint = (workspaceFiles?: { readonly include: readonly string[] }) => {
      const definition = publishTool();
      const { workspaceFiles: _omitted, ...execution } = definition.execution as Extract<
        NonNullable<ToolAdapterDefinition["execution"]>,
        { type: "http_callback" }
      >;
      return executionPlan(
        {
          ...definition,
          execution: { ...execution, ...(workspaceFiles ? { workspaceFiles } : {}) },
        },
        {},
      ).fingerprint;
    };
    const html = fingerprint({ include: ["site/*.html"] });

    expect(fingerprint({ include: ["site/*.html"] })).toBe(html);
    expect(fingerprint({ include: ["site/**"] })).not.toBe(html);
    expect(fingerprint()).not.toBe(html);
  });
});
describe("HTTP callbacks with workspace files", () => {
  test("attaches the thread sandbox files to the callback body", async () => {
    const { calls, run } = harness();

    await run();

    expect(calls.reads).toEqual([
      {
        include: ["site/*.html", "site/*.png"],
        sandboxPolicy: { mode: "thread-persistent", provider: "aws_lambda_microvm" },
      },
    ]);
    expect(calls.callbacks).toHaveLength(1);
    const body = JSON.parse(String(calls.callbacks[0]!.body));
    expect(body).toMatchObject({ input: { note: "launch" }, version: 1 });
    expect(body.workspaceFiles).toEqual({ files: [HTML, LOGO] });
    expect(calls.claims).toEqual(["begin", "succeed"]);
  });

  test.each(["run-ephemeral", "none"] as const)(
    "rejects %s runs as a known failure before reading or dispatching",
    async (mode) => {
      const { calls, run } = harness();
      const failure = await run(mode).catch((cause: unknown) => cause);

      expect(knownFailureMessage(failure)).toBe(
        "HTTP callback site.publish attaches workspace files and requires a thread-persistent sandbox policy.",
      );
      expect(calls.reads).toEqual([]);
      expect(calls.claims).toEqual([]);
      expect(calls.callbacks).toEqual([]);
    },
  );

  test("fails as known when the worker has no thread sandboxes", async () => {
    const { calls, run } = harness({ readFiles: null });
    const failure = await run().catch((cause: unknown) => cause);

    expect(knownFailureMessage(failure)).toContain(
      "thread-persistent sandboxes are not configured",
    );
    expect(calls.claims).toEqual([]);
  });

  test("replays a claimed mutation without re-reading files or dispatching", async () => {
    const stored: RuntimeToolExecutionResult = { outputSummary: "published", status: "completed" };
    const { calls, run } = harness({ replay: stored });

    expect(run()).resolves.toEqual(stored);
    expect(calls.reads).toEqual([]);
    expect(calls.dispatches).toBe(0);
    expect(calls.callbacks).toEqual([]);
  });

  test("retries sandbox read failures after releasing the claim, without dispatching", async () => {
    const { calls, run } = harness({
      readFiles: async () => {
        throw new Error("Sandbox allocation for site.publish did not complete.");
      },
    });

    expect(run()).rejects.toBeInstanceOf(RuntimeToolPreparationRetryableError);
    expect(calls.claims).toEqual(["begin", "release"]);
    expect(calls.dispatches).toBe(0);
  });

  test("completes with a model-visible error when the organization is at its sandbox limit", async () => {
    const { calls, run } = harness({
      readFiles: async () => {
        throw new Error("Sandbox allocation for site.publish did not complete.", {
          cause: new SandboxCapacityError({
            inUse: 3,
            limit: 3,
            message: "The organization reached its limit of 3 active sandboxes.",
            organizationId: ids.organizationId,
          }),
        });
      },
    });
    const message =
      "This organization reached its limit of 3 active sandboxes, so site.publish did not run. Try again after other sandbox work finishes, or continue without it.";

    expect(await run()).toEqual({
      output: { error: { code: "organization_sandbox_limit_reached", limit: 3, message } },
      outputSummary: `Tool site.publish failed: ${message}`,
      status: "completed",
    });
    expect(calls.claims).toEqual(["begin", "release"]);
    expect(calls.dispatches).toBe(0);
  });

  test("applies the request byte cap to the body with its files attached", async () => {
    const { calls, run } = harness({
      readFiles: async () => [{ ...HTML, content: "x".repeat(260 * 1024) }],
    });
    const failure = await run().catch((cause: unknown) => cause);

    expect(knownFailureMessage(failure)).toBe(
      "HTTP callback site.publish request exceeded 262144 bytes with its workspace files attached.",
    );
    expect(calls.claims).toEqual(["begin", "fail"]);
    expect(calls.dispatches).toBe(0);
  });

  test("dispatches read callbacks with files and no mutation claim", async () => {
    const { calls, run } = harness({ definition: publishTool("read") });

    await run();

    expect(calls.claims).toEqual([]);
    expect(JSON.parse(String(calls.callbacks[0]!.body)).workspaceFiles.files).toHaveLength(2);
  });
});

describe("callback workspace file reader", () => {
  function reader(stdout: unknown) {
    const commands: (readonly string[])[] = [];
    const acquired: unknown[] = [];
    const manager = {
      exec: (input: { readonly command: readonly string[] }) =>
        Effect.sync(() => {
          commands.push(input.command);
          return { durationMs: 1, exitCode: 0, stderr: "", stdout: `${JSON.stringify(stdout)}\n` };
        }),
    } as unknown as SandboxManagerService;
    const threadSandbox = {
      acquire: async (input: unknown) => {
        acquired.push(input);
        return {
          lease: { id: "thread" },
          record: { data: { id: "thread" } },
        } as unknown as ManagedSandbox;
      },
    } as unknown as ThreadSandboxWorkspace;
    const read = createCallbackWorkspaceFileReader({ manager, threadSandbox });
    const request = {
      ...ids,
      agentManifestHash: "sha256:manifest",
      captureMode: "metadata-only",
      spanId: "0123456789abcdef",
      traceId: "0123456789abcdef0123456789abcdef",
      decision: { toolCallId: "01J0000000000000000000000T" },
      sandboxPolicy: { mode: "thread-persistent", provider: "aws_lambda_microvm" },
      toolName: "site.publish",
    } as never;
    return { acquired, commands, read: () => read(request, { include: ["site/**"] }) };
  }

  test("runs the guest script in the acquired thread sandbox with the limits", async () => {
    const { acquired, commands, read } = reader({ files: [HTML, LOGO], status: "ok" });

    expect(read()).resolves.toEqual([HTML, LOGO]);
    expect(acquired).toHaveLength(1);
    expect(JSON.parse(commands[0]!.at(-1)!)).toEqual({
      include: ["site/**"],
      maxContentBytes: CALLBACK_WORKSPACE_FILES_MAX_CONTENT_BYTES,
      maxFiles: CALLBACK_WORKSPACE_FILES_MAX_FILES,
      root: "/workspace",
    });
  });

  test("names the exceeded limit instead of truncating", async () => {
    expect(reader({ count: 201, status: "too_many_files" }).read()).rejects.toThrow(
      "HTTP callback site.publish workspace files matched 201 files; the limit is 200.",
    );
    expect(reader({ status: "content_too_large" }).read()).rejects.toThrow(
      "HTTP callback site.publish workspace file text content exceeds the 196608-byte limit.",
    );
    expect(
      reader({
        files: [{ ...HTML, content: "x".repeat(CALLBACK_WORKSPACE_FILES_MAX_CONTENT_BYTES) }],
        status: "ok",
      }).read(),
    ).rejects.toThrow("196608-byte limit");
  });

  test("rejects guest output that escapes the workspace or is unsorted", async () => {
    for (const files of [
      [{ ...HTML, path: "../secret" }],
      [{ ...HTML, path: "/etc/passwd" }],
      [LOGO, HTML],
    ]) {
      expect(reader({ files, status: "ok" }).read()).rejects.toThrow(
        "returned workspace files outside the requested bounds",
      );
    }
  });
});
