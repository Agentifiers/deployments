import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Ulid } from "@deployments-ai/db";
import type { ManagedSandbox, SandboxManagerService } from "@deployments-ai/sandbox-hosts";
import { Effect } from "effect";
import {
  SANDBOX_FILES_READ_SCRIPT,
  SANDBOX_FILES_WRITE_SCRIPT,
} from "./sandbox-file-guest-scripts.ts";
import {
  createRuntimeSandboxFileBuiltinExecutors,
  sandboxWorkspacePath,
} from "./sandbox-file-runtime-tools.ts";
import type { ExecuteRuntimeBuiltinTool } from "./runtime-tools.ts";
import type { ThreadSandboxWorkspace } from "./thread-sandbox/contracts.ts";

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const TOOL_CALL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const sandbox = {
  lease: { status: "ready" },
  record: { data: { id: ID } },
} as unknown as ManagedSandbox;
const threadPolicy = {
  mode: "thread-persistent" as const,
  provider: "aws_lambda_microvm" as const,
};

function request(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    agentDefinitionId: ID,
    agentDeploymentId: ID,
    agentManifestHash: "sha256:manifest",
    agentReleaseId: ID,
    captureMode: "metadata-only" as const,
    decision: { action: "allow" as const, reason: "test", toolCallId: TOOL_CALL_ID },
    effect: "read" as const,
    environmentId: ID,
    idempotencyKey: "model-call-0",
    input,
    inputSummary: "sandbox files",
    organizationId: ID,
    projectId: ID,
    requiredScopes: [],
    runId: ID,
    sandboxPolicy: threadPolicy,
    spanId: "0123456789abcdef",
    threadId: ID,
    traceId: "0123456789abcdef0123456789abcdef",
    toolName,
    ...overrides,
  };
}

interface Harness {
  readonly acquired: unknown[];
  readonly execs: Parameters<SandboxManagerService["exec"]>[0][];
  readonly uploads: Parameters<SandboxManagerService["upload"]>[0][];
  readonly tools: Readonly<Record<string, ExecuteRuntimeBuiltinTool>>;
}

function harness(
  respond: (args: Readonly<Record<string, unknown>>) => {
    readonly exitCode?: number;
    readonly stderr?: string;
    readonly stdout: string;
  },
  threadSandbox: boolean = true,
): Harness {
  const acquired: unknown[] = [];
  const execs: Harness["execs"] = [];
  const uploads: Harness["uploads"] = [];
  const manager = {
    exec: (input: Parameters<SandboxManagerService["exec"]>[0]) => {
      execs.push(input);
      const response = respond(JSON.parse(input.command[3]!));
      return Effect.succeed({
        durationMs: 3,
        exitCode: response.exitCode ?? 0,
        stderr: response.stderr ?? "",
        stdout: response.stdout,
      });
    },
    upload: (input: Parameters<SandboxManagerService["upload"]>[0]) => {
      uploads.push(input);
      return Effect.void;
    },
  } as unknown as SandboxManagerService;
  const workspace: ThreadSandboxWorkspace = {
    acquire: async (input) => {
      acquired.push(input);
      return sandbox;
    },
    release: async () => {
      throw new Error("File tools must not release the thread sandbox.");
    },
  };
  return {
    acquired,
    execs,
    tools: createRuntimeSandboxFileBuiltinExecutors({
      manager,
      ...(threadSandbox ? { threadSandbox: workspace } : {}),
    }),
    uploads,
  };
}

const json = (value: unknown) => ({ stdout: `${JSON.stringify(value)}\n` });

describe("sandbox workspace path jail", () => {
  test("resolves relative paths and normalizes within /workspace", () => {
    expect(sandboxWorkspacePath("notes/a.txt")).toBe("/workspace/notes/a.txt");
    expect(sandboxWorkspacePath("./a/../b/")).toBe("/workspace/b");
    expect(sandboxWorkspacePath("/workspace//x//")).toBe("/workspace/x");
    expect(sandboxWorkspacePath("/workspace/")).toBe("/workspace");
    expect(sandboxWorkspacePath(".")).toBe("/workspace");
    expect(sandboxWorkspacePath("x".repeat(1024))).toBe(`/workspace/${"x".repeat(1024)}`);
  });

  test("rejects escapes, NUL, empty, and over-long paths as input errors", () => {
    for (const value of [
      "../etc/passwd",
      "a/../../workspace-other",
      "/etc/passwd",
      "/workspace/../etc",
      "/workspacex/a",
      "/",
      "a\0b",
      "",
      "x".repeat(1025),
      42,
    ]) {
      expect(() => sandboxWorkspacePath(value)).toThrow(TypeError);
    }
  });
});

describe("sandbox file tools", () => {
  test("reject non thread-persistent policies and escaping paths before acquiring", async () => {
    const run = harness(() => json({ status: "not_found" }));
    const read = run.tools["sandbox.files.read"]!;
    for (const mode of ["none", "run-ephemeral"]) {
      expect(
        read(
          request(
            "sandbox.files.read",
            { path: "a.txt" },
            {
              sandboxPolicy: { mode, provider: "aws_lambda_microvm" },
            },
          ),
          {} as never,
        ),
      ).rejects.toThrow(TypeError);
    }
    expect(
      read(request("sandbox.files.read", { path: "../secrets" }), {} as never),
    ).rejects.toThrow(TypeError);
    expect(run.acquired).toEqual([]);
  });

  test("fails as a runtime error when thread sandboxes are not configured", async () => {
    const run = harness(() => json({ status: "not_found" }), false);
    const call = run.tools["sandbox.files.list"]!(request("sandbox.files.list", {}), {} as never);
    expect(call).rejects.toThrow("Thread-persistent sandboxes are not configured.");
    expect(call).rejects.not.toBeInstanceOf(TypeError);
  });

  test("reads through the guest script and maps statuses to completed results", async () => {
    const run = harness((args) =>
      args.path === "/workspace/missing.txt"
        ? json({ status: "not_found" })
        : json({ byteSize: 10, content: "héllo", status: "ok", truncated: true }),
    );
    const read = run.tools["sandbox.files.read"]!;

    expect(
      read(request("sandbox.files.read", { maxBytes: 6, path: "docs/a.md" }), {} as never),
    ).resolves.toEqual({
      output: {
        byteSize: 10,
        content: "héllo",
        path: "/workspace/docs/a.md",
        status: "ok",
        truncated: true,
      },
      outputSummary: "Read the first 6 bytes of /workspace/docs/a.md (10 bytes, truncated).",
      status: "completed",
    });
    expect(
      read(request("sandbox.files.read", { path: "missing.txt" }), {} as never),
    ).resolves.toMatchObject({
      output: { path: "/workspace/missing.txt", status: "not_found" },
      status: "completed",
    });

    expect(run.acquired[0]).toEqual({
      environmentId: ID,
      executionTargetId: ID,
      executionTargetKind: "agent-deployment",
      observability: {
        captureMode: "metadata-only",
        runSpanId: "0123456789abcdef",
        sessionId: ID,
        traceId: "0123456789abcdef0123456789abcdef",
      },
      organizationId: ID,
      policy: threadPolicy,
      projectId: ID,
      runId: ID,
      threadId: ID,
    });
    expect(run.execs[0]).toMatchObject({
      command: [
        "python3",
        "-c",
        SANDBOX_FILES_READ_SCRIPT,
        JSON.stringify({ maxBytes: 6, path: "/workspace/docs/a.md" }),
      ],
      cwd: "/workspace",
      sandbox,
    });
    expect(JSON.parse(run.execs[1]!.command[3]!)).toEqual({
      maxBytes: 32 * 1024,
      path: "/workspace/missing.txt",
    });
  });

  test("bounds read maxBytes and rejects guest content beyond it", async () => {
    const run = harness(() =>
      json({ byteSize: 3, content: "abc", status: "ok", truncated: false }),
    );
    const read = run.tools["sandbox.files.read"]!;
    for (const maxBytes of [0, 65_537, 1.5]) {
      expect(
        read(request("sandbox.files.read", { maxBytes, path: "a" }), {} as never),
      ).rejects.toThrow(TypeError);
    }
    expect(
      read(request("sandbox.files.read", { maxBytes: 65_536, path: "a" }), {} as never),
    ).resolves.toMatchObject({ status: "completed" });
    const overrun = read(request("sandbox.files.read", { maxBytes: 2, path: "a" }), {} as never);
    expect(overrun).rejects.toThrow("returned more than 2 bytes");
    expect(overrun).rejects.not.toBeInstanceOf(TypeError);
  });

  test("uploads write content to a per-call temp file and verifies the stored digest", async () => {
    const content = "é".repeat(49_152);
    const bytes = new TextEncoder().encode(content);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let reportedDigest = sha256;
    const run = harness(() =>
      json({ byteSize: bytes.byteLength, sha256: reportedDigest, status: "ok" }),
    );
    const write = run.tools["sandbox.files.write"]!;

    expect(
      write(request("sandbox.files.write", { content, path: "/workspace/out/a.txt" }), {} as never),
    ).resolves.toEqual({
      output: { byteSize: 98_304, path: "/workspace/out/a.txt", sha256, status: "ok" },
      outputSummary: "Wrote 98304 bytes to /workspace/out/a.txt.",
      status: "completed",
    });
    const source = `/tmp/deployments-ai-write-${TOOL_CALL_ID}`;
    expect(run.uploads).toEqual([{ content: bytes, path: source, sandbox }]);
    expect(run.execs[0]!.command.slice(0, 3)).toEqual([
      "python3",
      "-c",
      SANDBOX_FILES_WRITE_SCRIPT,
    ]);
    expect(JSON.parse(run.execs[0]!.command[3]!)).toEqual({ path: "/workspace/out/a.txt", source });

    reportedDigest = "0".repeat(64);
    expect(
      write(request("sandbox.files.write", { content, path: "a.txt" }), {} as never),
    ).rejects.toThrow("stored different bytes");
  });

  test("rejects write content one byte over the UTF-8 limit before uploading", async () => {
    const run = harness(() => json({ status: "ok" }));
    expect(
      run.tools["sandbox.files.write"]!(
        request("sandbox.files.write", { content: `${"é".repeat(49_152)}a`, path: "a.txt" }),
        {} as never,
      ),
    ).rejects.toThrow(TypeError);
    expect(
      run.tools["sandbox.files.write"]!(
        request("sandbox.files.write", { content: 7, path: "a.txt" }),
        {} as never,
      ),
    ).rejects.toThrow(TypeError);
    expect(run.uploads).toEqual([]);
    expect(run.acquired).toEqual([]);
  });

  test("returns write conflicts as completed statuses", async () => {
    const run = harness((args) =>
      json({ status: args.path === "/workspace" ? "is_a_directory" : "parent_not_directory" }),
    );
    const write = run.tools["sandbox.files.write"]!;
    expect(
      write(request("sandbox.files.write", { content: "", path: "/workspace" }), {} as never),
    ).resolves.toMatchObject({ output: { path: "/workspace", status: "is_a_directory" } });
    expect(
      write(request("sandbox.files.write", { content: "x", path: "f/x" }), {} as never),
    ).resolves.toMatchObject({
      output: { path: "/workspace/f/x", status: "parent_not_directory" },
    });
  });

  test("lists with defaults and rejects entries outside the requested directory", async () => {
    let entries: unknown[] = [
      { byteSize: 4, path: "/workspace/a.txt", type: "file" },
      { path: "/workspace/link", type: "symlink" },
    ];
    const run = harness(() => json({ entries, status: "ok", truncated: true }));
    const list = run.tools["sandbox.files.list"]!;

    expect(list(request("sandbox.files.list", {}), {} as never)).resolves.toEqual({
      output: { entries, path: "/workspace", status: "ok", truncated: true },
      outputSummary: "Listed 2 entries under /workspace (truncated).",
      status: "completed",
    });
    expect(JSON.parse(run.execs[0]!.command[3]!)).toEqual({
      limit: 200,
      path: "/workspace",
      recursive: false,
    });

    entries = [{ path: "/workspacex/a", type: "directory" }];
    expect(list(request("sandbox.files.list", {}), {} as never)).rejects.toThrow(
      "entries outside the request",
    );
    entries = [{ path: "/workspace/a", type: "file" }];
    expect(list(request("sandbox.files.list", {}), {} as never)).rejects.toThrow(
      "unexpected sandbox output",
    );
    for (const input of [{ limit: 0 }, { limit: 501 }, { recursive: "yes" }]) {
      expect(list(request("sandbox.files.list", input), {} as never)).rejects.toThrow(TypeError);
    }
  });

  test("maps missing and non-directory list targets to completed statuses", async () => {
    const run = harness((args) =>
      json({ status: args.path === "/workspace/gone" ? "not_found" : "not_a_directory" }),
    );
    const list = run.tools["sandbox.files.list"]!;
    expect(
      list(
        request("sandbox.files.list", { path: "gone", recursive: true, limit: 500 }),
        {} as never,
      ),
    ).resolves.toMatchObject({
      output: { entries: [], path: "/workspace/gone", status: "not_found", truncated: false },
    });
    expect(
      list(request("sandbox.files.list", { path: "file.txt" }), {} as never),
    ).resolves.toMatchObject({ output: { status: "not_a_directory" } });
  });

  test("treats script failures and malformed output as runtime errors with redacted stderr", async () => {
    let response: { exitCode?: number; stderr?: string; stdout: string } = {
      exitCode: 1,
      stderr: "Traceback: password=hunter2",
      stdout: "",
    };
    const run = harness(() => response);
    const read = run.tools["sandbox.files.read"]!;

    const failed = read(request("sandbox.files.read", { path: "a" }), {} as never);
    expect(failed).rejects.toThrow("failed in the sandbox (exit 1)");
    expect(failed).rejects.not.toThrow("hunter2");
    expect(failed).rejects.not.toBeInstanceOf(TypeError);

    for (const stdout of ["not json", '{"status":"exploded"}', "[]"]) {
      response = { stdout };
      expect(read(request("sandbox.files.read", { path: "a" }), {} as never)).rejects.toThrow(
        "unexpected sandbox output",
      );
    }
  });
});
