import { describe, expect, test } from "bun:test";
import type { Ulid } from "@deployments-ai/db";
import type { ManagedSandbox, SandboxManagerService } from "@deployments-ai/sandbox-hosts";
import { Effect } from "effect";
import {
  computerActionInput,
  createRuntimeComputerBuiltinExecutors,
} from "./computer-runtime-tools.ts";
import type { ThreadSandboxWorkspace } from "./thread-sandbox/contracts.ts";

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const TOOL_CALL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const sandbox = {
  lease: { status: "ready" },
  record: { data: { id: ID } },
} as unknown as ManagedSandbox;

function request(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  mode = "thread-persistent",
) {
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
    input,
    inputSummary: "computer",
    organizationId: ID,
    projectId: ID,
    requiredScopes: [],
    runId: ID,
    sandboxPolicy: { mode, provider: "aws_lambda_microvm" },
    spanId: "0123456789abcdef",
    threadId: ID,
    traceId: "0123456789abcdef0123456789abcdef",
    toolName,
  } as never;
}

function harness(stdout: unknown) {
  const execs: Parameters<SandboxManagerService["exec"]>[0][] = [];
  const downloads: string[] = [];
  const manager = {
    download: (input: { readonly path: string }) => {
      downloads.push(input.path);
      return Effect.succeed(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(PNG);
            controller.close();
          },
        }),
      );
    },
    exec: (input: Parameters<SandboxManagerService["exec"]>[0]) => {
      execs.push(input);
      return Effect.succeed({
        durationMs: 3,
        exitCode: 0,
        stderr: "",
        stdout: `${JSON.stringify(stdout)}\n`,
      });
    },
  } as unknown as SandboxManagerService;
  const threadSandbox: ThreadSandboxWorkspace = {
    acquire: async () => sandbox,
    release: async () => {
      throw new Error("Computer tools must not release the thread sandbox.");
    },
  };
  return {
    downloads,
    execs,
    tools: createRuntimeComputerBuiltinExecutors({ manager, threadSandbox }),
  };
}

const desktop = {
  screenHeight: 800,
  screenWidth: 1280,
  status: "ok",
  windows: [{ app: "firefox", height: 770, title: "Example", width: 1280, x: 0, y: 30 }],
};

describe("computer action input", () => {
  test("keeps only the fields each action uses and applies defaults", () => {
    expect(computerActionInput({ action: "click", text: "ignored", x: 10, y: 20 })).toEqual({
      action: "click",
      x: 10,
      y: 20,
    });
    expect(computerActionInput({ action: "scroll", direction: "down", x: 1, y: 2 })).toEqual({
      action: "scroll",
      amount: 3,
      direction: "down",
      x: 1,
      y: 2,
    });
    expect(
      computerActionInput({ action: "key", key: "l", modifiers: ["ctrl", "ctrl", "shift"] }),
    ).toEqual({ action: "key", key: "l", modifiers: ["ctrl", "shift"] });
    expect(computerActionInput({ action: "key", key: "enter" })).toEqual({
      action: "key",
      key: "enter",
      modifiers: [],
    });
  });

  test("rejects missing, out-of-range, and unsupported fields", () => {
    for (const input of [
      { action: "click", x: 10 },
      { action: "click", x: -1, y: 0 },
      { action: "click", x: 1.5, y: 0 },
      { action: "drag", x: 1, y: 2, toX: 3 },
      { action: "type", text: "" },
      { action: "type", text: "x".repeat(4_001) },
      { action: "key", key: "l", modifiers: ["meta"] },
      { action: "scroll", direction: "sideways", x: 1, y: 2 },
      { action: "scroll", amount: 51, direction: "up", x: 1, y: 2 },
      { action: "launch", app: "firefox", url: "file:///etc/passwd" },
      { action: "launch", app: "/usr/bin/firefox --profile /tmp" },
      { action: "screenshot" },
    ]) {
      expect(() => computerActionInput(input), JSON.stringify(input)).toThrow(TypeError);
    }
  });
});

describe("computer runtime tools", () => {
  test("an action returns its screenshot as a model-visible screenshot artifact", async () => {
    const { downloads, execs, tools } = harness(desktop);

    const result = await tools["computer.action"]!(
      request("computer.action", { action: "click", settleMs: 250, x: 640, y: 400 }),
      {} as never,
    );

    const args = JSON.parse(execs[0]!.command[3]!);
    expect(args).toEqual({
      action: { action: "click", x: 640, y: 400 },
      screenshotPath: `/var/tmp/deployments-ai-computer/${TOOL_CALL_ID}.png`,
      settleMs: 250,
    });
    expect(downloads).toEqual([args.screenshotPath]);
    expect(result).toMatchObject({
      artifacts: [
        {
          content: PNG,
          contentType: "image/png",
          metadata: { toolCallId: TOOL_CALL_ID, viewport: "1280x800" },
          type: "screenshot",
          visibility: "private",
        },
      ],
      output: { action: "click", screenHeight: 800, screenWidth: 1280, windows: desktop.windows },
      outputSummary: "Click at (640, 400): 1280x800 screenshot, 1 open window.",
      status: "completed",
    });
  });

  test("a launch whose app is still starting tells the model to wait instead of relaunching", async () => {
    const { tools } = harness({ ...desktop, launchStatus: "starting", windows: [] });

    const result = await tools["computer.action"]!(
      request("computer.action", { action: "launch", app: "firefox" }),
      {} as never,
    );

    expect(result.output).toMatchObject({ action: "launch", launchStatus: "starting" });
    expect(result.outputSummary).toBe(
      "Launched firefox, which is still starting; take a screenshot in a few seconds instead of launching it again: 1280x800 screenshot, 0 open windows.",
    );
  });

  test("a refused action still returns the screenshot, with the driver's error", async () => {
    const { tools } = harness({ ...desktop, actionError: "background_unavailable" });

    const result = await tools["computer.action"]!(
      request("computer.action", { action: "type", text: "hello" }),
      {} as never,
    );

    expect(result.artifacts).toHaveLength(1);
    expect(result.output).toMatchObject({
      error: { code: "action_failed", message: "background_unavailable" },
    });
    expect(result.outputSummary).toStartWith("The type action failed (background_unavailable)");
  });

  test("reports no_desktop without reading a screenshot", async () => {
    const { downloads, tools } = harness({ status: "no_desktop" });

    const result = await tools["computer.screenshot"]!(
      request("computer.screenshot", {}),
      {} as never,
    );

    expect(downloads).toEqual([]);
    expect(result).toMatchObject({
      output: { error: { code: "no_desktop" } },
      status: "completed",
    });
  });

  test("requires a thread-persistent sandbox", async () => {
    const { execs, tools } = harness(desktop);

    const error = await tools["computer.screenshot"]!(
      request("computer.screenshot", {}, "run-ephemeral"),
      {} as never,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TypeError);
    expect(execs).toEqual([]);
  });
});
