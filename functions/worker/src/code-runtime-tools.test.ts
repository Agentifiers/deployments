import { describe, expect, test } from "bun:test";
import type { Ulid } from "@deployments-ai/db";
import type { ManagedSandbox, SandboxManagerService } from "@deployments-ai/sandbox-hosts";
import { Effect } from "effect";
import { createRuntimeCodeBuiltinExecutors } from "./code-runtime-tools.ts";

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const TOOL_CALL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const WORKSPACE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;
const sandbox = {
  lease: {
    environmentId: ID,
    executionTargetId: ID,
    executionTargetKind: "agent-deployment",
    externalSandboxId: "microvm-test",
    isolationMode: "run-ephemeral",
    organizationId: ID,
    projectId: ID,
    provider: "aws_lambda_microvm",
    runId: ID,
    status: "ready",
  },
  record: { data: { id: TOOL_CALL_ID } },
} as unknown as ManagedSandbox;

function request(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    agentDefinitionId: ID,
    agentDeploymentId: ID,
    agentManifestHash: "sha256:manifest",
    agentReleaseId: ID,
    captureMode: "metadata-only" as const,
    decision: { action: "allow" as const, reason: "test", toolCallId: TOOL_CALL_ID },
    effect: "execute" as const,
    environmentId: ID,
    idempotencyKey: "model-call-0",
    input: { code: "print('hello')", language: "python", timeoutMs: 1_000 },
    inputSummary: "execute code",
    organizationId: ID,
    projectId: ID,
    requiredScopes: [],
    runId: ID,
    sandboxPolicy: {
      minMemoryMiB: 2_048,
      minVcpu: 1,
      mode: "run-ephemeral" as const,
      provider: "aws_lambda_microvm" as const,
    },
    spanId: "0123456789abcdef",
    threadId: ID,
    traceId: "0123456789abcdef0123456789abcdef",
    toolName: "code.execute",
    ...overrides,
  };
}

function manager(
  options: {
    readonly destroy?: () => Effect.Effect<unknown, unknown>;
    readonly exec?: (
      input: Parameters<SandboxManagerService["exec"]>[0],
    ) => Effect.Effect<unknown, unknown>;
    readonly observed?: unknown[];
  } = {},
) {
  const observed = options.observed ?? [];
  return {
    create: (input: unknown) => {
      observed.push({ create: input });
      return Effect.succeed(sandbox);
    },
    destroy: () => {
      observed.push({ destroy: true });
      return options.destroy?.() ?? Effect.succeed({});
    },
    exec: (input: Parameters<SandboxManagerService["exec"]>[0]) => {
      observed.push({ exec: input });
      return (options.exec?.(input) ??
        Effect.succeed({
          durationMs: 12,
          exitCode: 0,
          stderr: "",
          stdout: "hello\npassword=do-not-leak",
        })) as ReturnType<SandboxManagerService["exec"]>;
    },
    upload: (input: Parameters<SandboxManagerService["upload"]>[0]) => {
      observed.push({ upload: input });
      return Effect.void;
    },
  } as unknown as SandboxManagerService;
}

describe("runtime code tool", () => {
  test("executes source in a fresh Lambda MicroVM and destroys it", async () => {
    const observed: unknown[] = [];
    const executor = createRuntimeCodeBuiltinExecutors({
      manager: manager({ observed }),
      providerName: "aws_lambda_microvm",
    })["code.execute"]!;

    const result = await executor(request(), {} as never);

    expect(observed).toHaveLength(4);
    expect(observed[0]).toMatchObject({
      create: {
        allocationId: TOOL_CALL_ID,
        minMemoryMiB: 2_048,
        minVcpu: 1,
        observability: {
          captureMode: "metadata-only",
          runSpanId: "0123456789abcdef",
          sessionId: ID,
          traceId: "0123456789abcdef0123456789abcdef",
        },
        runId: ID,
      },
    });
    expect(observed[1]).toMatchObject({
      upload: { path: "/tmp/deployments-ai-code.py" },
    });
    expect((observed[1] as { upload: { content: Uint8Array } }).upload.content).toEqual(
      new TextEncoder().encode("print('hello')"),
    );
    expect(observed[2]).toMatchObject({
      exec: { command: ["python3", "/tmp/deployments-ai-code.py"], timeoutMs: 1_000 },
    });
    expect(observed[2]).not.toHaveProperty("exec.cwd");
    expect(observed[3]).toEqual({ destroy: true });
    expect(result).toMatchObject({
      output: {
        durationMs: 12,
        exitCode: 0,
        stdout: "hello\npassword=[redacted]",
      },
      status: "completed",
    });
    expect(result.artifacts?.[0]?.content).not.toContain("do-not-leak");
  });

  test("reports non-zero exits as completed results so the model can recover", async () => {
    const executor = createRuntimeCodeBuiltinExecutors({
      manager: manager({
        exec: () => Effect.succeed({ durationMs: 2, exitCode: 7, stderr: "bad input", stdout: "" }),
      }),
      providerName: "aws_lambda_microvm",
    })["code.execute"]!;

    expect(executor(request(), {} as never)).resolves.toMatchObject({
      output: { exitCode: 7, stderr: "bad input" },
      status: "completed",
    });
  });

  test("bounds aggregate escaped structured output and persists replay evidence", async () => {
    const executor = createRuntimeCodeBuiltinExecutors({
      manager: manager({
        exec: () =>
          Effect.succeed({
            durationMs: 2,
            exitCode: 0,
            stderr: "\0".repeat(64 * 1024),
            stdout: "\0".repeat(64 * 1024),
          }),
      }),
      providerName: "aws_lambda_microvm",
    })["code.execute"]!;

    const result = await executor(request(), {} as never);

    expect(new TextEncoder().encode(JSON.stringify(result.output)).byteLength).toBeLessThanOrEqual(
      96 * 1024,
    );
    expect(result.output).toMatchObject({ stderrTruncated: true, stdoutTruncated: true });
    const durable = executor.mutationClaimResult?.(result);
    expect(durable).toMatchObject({ artifacts: [], status: "completed" });
    expect(durable?.output).toEqual(result.output);
    expect(durable?.outputSummary).toBe(result.outputSummary);
    expect(
      new TextEncoder().encode(String(result.artifacts?.[0]?.content)).byteLength,
    ).toBeLessThanOrEqual(42 * 1024);
    const replay = await executor.refreshReplay?.(request(), {} as never, {
      artifacts: [],
      ...(durable?.output ? { output: durable.output } : {}),
      ...(durable?.outputSummary ? { outputSummary: durable.outputSummary } : {}),
      status: "completed",
    });
    expect(replay?.artifacts?.[0]).toMatchObject({
      fileName: `code-execute-${TOOL_CALL_ID}.txt`,
      label: "Sandboxed code output",
    });
    expect(replay?.output).toEqual(result.output);
  });

  test("always attempts cleanup and rejects policies that do not enable the sandbox", async () => {
    let destroyed = false;
    const executor = createRuntimeCodeBuiltinExecutors({
      manager: manager({
        destroy: () => {
          destroyed = true;
          return Effect.succeed({});
        },
        exec: () => Effect.fail(new Error("transport outcome unknown")),
      }),
      providerName: "aws_lambda_microvm",
    })["code.execute"]!;

    expect(executor(request(), {} as never)).rejects.toThrow(
      "did not reach a clean terminal state",
    );
    expect(destroyed).toBe(true);
    expect(
      executor(
        request({ sandboxPolicy: { mode: "none", provider: "aws_lambda_microvm" } }),
        {} as never,
      ),
    ).rejects.toThrow("requires a run-ephemeral or thread-persistent sandbox policy");
  });

  test("runs in the thread's persistent sandbox from /workspace and leaves it running", async () => {
    const observed: unknown[] = [];
    const acquired: unknown[] = [];
    const threadPolicy = {
      mode: "thread-persistent" as const,
      provider: "aws_lambda_microvm" as const,
    };
    const executor = createRuntimeCodeBuiltinExecutors({
      manager: manager({ observed }),
      providerName: "aws_lambda_microvm",
      threadSandbox: {
        acquire: async (input) => {
          acquired.push(input);
          return sandbox;
        },
        release: async () => {
          throw new Error("code.execute must not release the thread sandbox.");
        },
      },
    })["code.execute"]!;

    const result = await executor(
      request({
        input: { code: "echo hi", language: "bash" },
        sandboxPolicy: threadPolicy,
        workspaceId: WORKSPACE_ID,
      }),
      {} as never,
    );

    expect(acquired).toEqual([
      {
        environmentId: ID,
        executionTargetId: ID,
        executionTargetKind: "agent-deployment",
        observability: {
          captureMode: "metadata-only",
          runSpanId: "0123456789abcdef",
          sessionId: ID,
          traceId: "0123456789abcdef0123456789abcdef",
          workspaceId: WORKSPACE_ID,
        },
        organizationId: ID,
        policy: threadPolicy,
        projectId: ID,
        runId: ID,
        threadId: ID,
        workspaceId: WORKSPACE_ID,
      },
    ]);
    const path = `/tmp/deployments-ai-code-${TOOL_CALL_ID}.sh`;
    expect(observed).toEqual([
      { upload: { content: new TextEncoder().encode("echo hi"), path, sandbox } },
      {
        exec: {
          command: ["bash", path],
          cwd: "/workspace",
          sandbox,
          timeoutMs: 30_000,
        },
      },
    ]);
    expect(result).toMatchObject({
      artifacts: [{ fileName: `code-execute-${TOOL_CALL_ID}.txt` }],
      output: { exitCode: 0, stdout: "hello\npassword=[redacted]" },
      status: "completed",
    });
  });

  test("fails thread-persistent calls when the worker has no thread sandbox backing", async () => {
    const observed: unknown[] = [];
    const executor = createRuntimeCodeBuiltinExecutors({
      manager: manager({ observed }),
      providerName: "aws_lambda_microvm",
    })["code.execute"]!;
    const call = executor(
      request({ sandboxPolicy: { mode: "thread-persistent", provider: "aws_lambda_microvm" } }),
      {} as never,
    );

    expect(call).rejects.toThrow("Thread-persistent sandboxes are not configured.");
    expect(call).rejects.not.toBeInstanceOf(TypeError);
    expect(observed).toEqual([]);
  });

  test("rejects source above the 20 KiB UTF-8 boundary before allocation", async () => {
    let allocations = 0;
    const oversizedManager = {
      ...manager(),
      create: () => {
        allocations += 1;
        return Effect.succeed(sandbox);
      },
    } as unknown as SandboxManagerService;
    const boundedExecutor = createRuntimeCodeBuiltinExecutors({
      manager: oversizedManager,
      providerName: "aws_lambda_microvm",
    })["code.execute"]!;

    expect(
      boundedExecutor(
        request({ input: { code: "é".repeat(10_241), language: "python" } }),
        {} as never,
      ),
    ).rejects.toThrow("code is too long");
    expect(allocations).toBe(0);
  });
});
