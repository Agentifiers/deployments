import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RuntimeToolPreparationRetryableError } from "@deployments-ai/agent-runtime";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import {
  hostedCodeRequest,
  hostedCodeTool,
  localSandbox,
  PYTHON,
  scriptedSandbox,
  sandboxRefusingExec,
  type SandboxCall,
  withExecutor,
} from "./executor.fixture.ts";
import { makeRuntimeRunLogRegistry } from "../runtime-log-emitter.ts";
import { HOSTED_CODE_NODE_RUNNER, HOSTED_CODE_PYTHON_RUNNER } from "./runners.ts";

let root = "";
/** Real interpreter runs; cold `node`/`python3` start-up is slow on loaded machines. */
const GUEST_RUN_TIMEOUT_MS = 60_000;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hosted-code-")));
});
afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

const ORDER_OUTPUT_SCHEMA = {
  additionalProperties: false,
  properties: { orderId: { type: "string" }, status: { type: "string" } },
  required: ["orderId", "status"],
  type: "object",
};

const ORDER_TOOL = `export async function lookup(input) {
  console.log("looking up", input.orderId);
  return { orderId: input.orderId, status: "shipped" };
}
`;

describe("hosted code executor", () => {
  test(
    "runs the pinned JavaScript artifact with its limits and returns schema-checked output",
    async () => {
      const calls: SandboxCall[] = [];
      const tool = hostedCodeTool(ORDER_TOOL, {
        execution: { entrypoint: "lookup", memoryMiB: 384, timeoutMs: 7_000 },
        outputSchema: ORDER_OUTPUT_SCHEMA,
      });
      const { execute, s3Reads } = withExecutor(tool, { manager: localSandbox(root, calls) });

      const result = await execute(hostedCodeRequest({ orderId: "ord_1" }), tool.definition);

      expect(result.status).toBe("completed");
      expect(result.output).toMatchObject({
        exitCode: 0,
        output: { orderId: "ord_1", status: "shipped" },
        stdout: "",
      });
      expect(String(result.output?.stderr)).toContain("looking up ord_1");
      expect(s3Reads).toEqual([
        {
          Bucket: tool.definition.execution.artifact.bucket,
          Key: tool.definition.execution.artifact.key,
          VersionId: tool.definition.execution.artifact.versionId,
        },
      ]);
      const uploads = calls.flatMap((call) => ("upload" in call ? [call.upload] : []));
      const staging = dirname(uploads[0]!.path);
      expect(uploads.map((upload) => upload.path.slice(staging.length + 1))).toEqual([
        "tool.mjs",
        "input.json",
        "runner.mjs",
      ]);
      expect(uploads[0]!.content).toEqual(tool.bytes);
      expect(JSON.parse(new TextDecoder().decode(uploads[1]!.content))).toEqual({
        entrypoint: "lookup",
        input: { orderId: "ord_1" },
        memoryMiB: 384,
      });
      expect(new TextDecoder().decode(uploads[2]!.content)).toBe(HOSTED_CODE_NODE_RUNNER);
      const exec = calls.find((call) => "exec" in call);
      expect(exec).toMatchObject({
        exec: {
          command: ["node", `${staging}/runner.mjs`],
          env: { NODE_OPTIONS: "--max-old-space-size=384" },
          network: "none",
          timeoutMs: 7_000,
        },
      });
      expect(existsSync(join(root, staging))).toBe(false);
      expect(calls.at(-1)).toEqual({ destroy: true });
    },
    GUEST_RUN_TIMEOUT_MS,
  );

  test(
    "reports a thrown handler error as a completed non-zero result",
    async () => {
      const tool = hostedCodeTool(
        `export function handler() { throw new RangeError("order ord_2 is archived"); }\n`,
      );
      const { execute } = withExecutor(tool, { manager: localSandbox(root) });

      const result = await execute(hostedCodeRequest({ orderId: "ord_2" }), tool.definition);

      expect(result.status).toBe("completed");
      expect(result.output).toMatchObject({
        error: { message: "order ord_2 is archived", name: "RangeError" },
        exitCode: 1,
      });
      expect(result.output).not.toHaveProperty("output");
    },
    GUEST_RUN_TIMEOUT_MS,
  );

  test("rejects input that violates the pinned input schema before reading code or allocating a sandbox", async () => {
    const calls: SandboxCall[] = [];
    const tool = hostedCodeTool(ORDER_TOOL);
    const { execute, s3Reads } = withExecutor(tool, { manager: scriptedSandbox(calls) });

    const rejection = await execute(hostedCodeRequest({ orderId: 42 }), tool.definition).catch(
      (cause: unknown) => cause,
    );

    expect(rejection).toBeInstanceOf(TypeError);
    expect(s3Reads).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test(
    "fails deterministically when the handler output violates the pinned output schema",
    async () => {
      const calls: SandboxCall[] = [];
      for (const source of [
        `export function handler(input) { return { orderId: input.orderId, status: 7 }; }\n`,
        `export function handler() { return ["not", "an", "object"]; }\n`,
      ]) {
        const tool = hostedCodeTool(source, { outputSchema: ORDER_OUTPUT_SCHEMA });
        const { execute } = withExecutor(tool, { manager: localSandbox(root, calls) });

        expect(
          execute(hostedCodeRequest({ orderId: "ord_3" }), tool.definition),
        ).rejects.toBeInstanceOf(TypeError);
      }
      expect(calls.filter((call) => "destroy" in call)).toHaveLength(2);
    },
    GUEST_RUN_TIMEOUT_MS,
  );

  test(
    "injects only pinned secret names and redacts their values from every returned field",
    async () => {
      const calls: SandboxCall[] = [];
      const secretReads: unknown[] = [];
      const tool = hostedCodeTool(
        `export function handler() {
  console.log("calling warehouse with", process.env.ORDERS_TOKEN);
  process.stderr.write(JSON.stringify({ header: process.env.ORDERS_TOKEN }) + "\\n");
  return {
    echoed: process.env.ORDERS_TOKEN,
    pin: process.env.PIN,
    unpinned: process.env.WAREHOUSE_TOKEN ?? null,
  };
}
`,
        {
          credential: { credentialId: "01ARZ3NDEKTSV4RRFFQ69G5FC9", generation: 3 },
          execution: { secretNames: ["ORDERS_TOKEN", "PIN"] },
        },
      );
      const { execute } = withExecutor(tool, {
        manager: localSandbox(root, calls),
        readSecrets: async (request) => {
          secretReads.push(request);
          return { ORDERS_TOKEN: 'tok_"live"_123', PIN: "123", WAREHOUSE_TOKEN: "wh_secret_456" };
        },
      });

      const result = await execute(hostedCodeRequest({}), tool.definition);

      expect(secretReads).toEqual([
        {
          credential: { credentialId: "01ARZ3NDEKTSV4RRFFQ69G5FC9", generation: 3 },
          environmentId: hostedCodeRequest({}).environmentId,
          organizationId: hostedCodeRequest({}).organizationId,
          projectId: hostedCodeRequest({}).projectId,
          toolAdapterId: tool.definition.toolAdapterId,
        },
      ]);
      const exec = calls.find((call) => "exec" in call);
      expect(Object.keys(exec && "exec" in exec ? (exec.exec.env ?? {}) : {}).toSorted()).toEqual([
        "NODE_OPTIONS",
        "ORDERS_TOKEN",
        "PIN",
      ]);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("live");
      expect(serialized).not.toContain("wh_secret_456");
      expect(result.output).toMatchObject({
        output: { echoed: "[redacted secret]", pin: "123", unpinned: null },
      });
      expect(String(result.output?.stderr)).toContain("calling warehouse with [redacted secret]");
      expect(String(result.output?.stderr)).toContain('{"header":"[redacted secret]"}');
    },
    GUEST_RUN_TIMEOUT_MS,
  );

  test(
    "hands what the code printed, without its secrets, to the run's runtime log",
    async () => {
      const tool = hostedCodeTool(
        `export function handler() {
  console.log("calling warehouse with", process.env.ORDERS_TOKEN);
  return { ok: true };
}
`,
        {
          credential: { credentialId: "01ARZ3NDEKTSV4RRFFQ69G5FC9", generation: 3 },
          execution: { secretNames: ["ORDERS_TOKEN"] },
        },
      );
      const request = hostedCodeRequest({});
      const received: unknown[] = [];
      const runtimeLogs = makeRuntimeRunLogRegistry();
      runtimeLogs.register(request.runId, {
        close: async () => {},
        log: (entry) => received.push({ kind: "log", ...entry }),
        processOutput: (output) => received.push({ kind: "output", ...output }),
      });
      const { execute } = withExecutor(tool, {
        manager: localSandbox(root),
        readSecrets: async () => ({ ORDERS_TOKEN: "tok_live_123" }),
        runtimeLogs,
      });

      await execute(request, tool.definition);

      expect(JSON.stringify(received)).not.toContain("tok_live_123");
      expect(received).toEqual([
        expect.objectContaining({
          kind: "output",
          source: "hosted-code",
          text: expect.stringContaining("calling warehouse with [redacted secret]"),
          toolCallId: request.decision.toolCallId,
        }),
        expect.objectContaining({
          attributes: expect.objectContaining({ exitCode: 0 }),
          kind: "log",
          level: "info",
          source: "hosted-code",
          toolCallId: request.decision.toolCallId,
        }),
      ]);
    },
    GUEST_RUN_TIMEOUT_MS,
  );

  test("fails deterministically when a pinned secret is gone and retries when the vault is unavailable", async () => {
    const tool = hostedCodeTool(ORDER_TOOL, {
      credential: { credentialId: "01ARZ3NDEKTSV4RRFFQ69G5FC9", generation: 1 },
      execution: { secretNames: ["ORDERS_TOKEN"] },
    });
    const calls: SandboxCall[] = [];
    const missing = withExecutor(tool, {
      manager: scriptedSandbox(calls),
      readSecrets: async () => ({ OTHER: "value-other" }),
    });
    expect(
      missing.execute(hostedCodeRequest({ orderId: "ord_4" }), tool.definition),
    ).rejects.toBeInstanceOf(TypeError);

    const unavailable = withExecutor(tool, {
      manager: scriptedSandbox(calls),
      readSecrets: async () => {
        throw new Error("vault throttled");
      },
    });
    expect(
      unavailable.execute(hostedCodeRequest({ orderId: "ord_4" }), tool.definition),
    ).rejects.toBeInstanceOf(RuntimeToolPreparationRetryableError);
    expect(calls).toHaveLength(0);
  });

  test("reports a timeout as a completed result with exit code 124", async () => {
    const calls: SandboxCall[] = [];
    const tool = hostedCodeTool(ORDER_TOOL, { execution: { timeoutMs: 1_500 } });
    const { execute } = withExecutor(tool, {
      manager: scriptedSandbox(calls, () =>
        Effect.succeed({
          durationMs: 1_500,
          exitCode: 124,
          stderr: "Command timed out after 1500 ms",
          stdout: "",
        }),
      ),
    });

    const result = await execute(hostedCodeRequest({ orderId: "ord_5" }), tool.definition);

    expect(result.status).toBe("completed");
    expect(result.output).toMatchObject({ exitCode: 124, timedOut: true });
    expect(result.output).not.toHaveProperty("output");
    expect(calls.find((call) => "exec" in call)).toMatchObject({ exec: { timeoutMs: 1_500 } });
  });

  test("refuses artifact bytes that do not match the release-pinned hash", async () => {
    const calls: SandboxCall[] = [];
    const tool = hostedCodeTool(ORDER_TOOL);
    const tampered = new TextEncoder().encode(ORDER_TOOL.replace("shipped", "stolen!"));
    expect(tampered.byteLength).toBe(tool.bytes.byteLength);
    const { execute } = withExecutor(tool, { manager: scriptedSandbox(calls), objects: tampered });

    expect(
      execute(hostedCodeRequest({ orderId: "ord_6" }), tool.definition),
    ).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);

    const unreadable = withExecutor(tool, { manager: scriptedSandbox(calls), objects: "missing" });
    expect(
      unreadable.execute(hostedCodeRequest({ orderId: "ord_6" }), tool.definition),
    ).rejects.toBeInstanceOf(RuntimeToolPreparationRetryableError);

    const foreign = hostedCodeTool(ORDER_TOOL, { bucket: "customer-controlled-bucket" });
    const outside = withExecutor(foreign, { manager: scriptedSandbox(calls) });
    expect(
      outside.execute(hostedCodeRequest({ orderId: "ord_6" }), foreign.definition),
    ).rejects.toBeInstanceOf(TypeError);
    expect(outside.s3Reads).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test.each([
    [404, "an image whose control server predates isolated exec"],
    [422, "a guest that cannot create a network namespace"],
  ])("fails deterministically when the sandbox answers %i (%s)", async (status) => {
    const calls: SandboxCall[] = [];
    const tool = hostedCodeTool(ORDER_TOOL);
    const { execute } = withExecutor(tool, { manager: sandboxRefusingExec(status, calls) });

    const rejection = await execute(hostedCodeRequest({ orderId: "ord_7" }), tool.definition).catch(
      (cause: unknown) => cause,
    );

    expect(rejection).toBeInstanceOf(TypeError);
    expect(calls.at(-1)).toEqual({ destroy: true });
  });

  test("leaves an exec with an unknown outcome (503) to retry/recovery instead of failing it", async () => {
    const tool = hostedCodeTool(ORDER_TOOL);
    const { execute } = withExecutor(tool, { manager: sandboxRefusingExec(503) });

    const rejection = await execute(hostedCodeRequest({ orderId: "ord_8" }), tool.definition).catch(
      (cause: unknown) => cause,
    );

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBeInstanceOf(TypeError);
    expect(rejection).not.toBeInstanceOf(RuntimeToolPreparationRetryableError);
  });
});

describe.skipIf(!PYTHON)("hosted code executor (Python)", () => {
  test(
    "runs an async Python handler with stdout kept out of the result envelope",
    async () => {
      const calls: SandboxCall[] = [];
      const tool = hostedCodeTool(
        `import asyncio


async def handler(payload):
    print("adding", payload["a"], payload["b"])
    await asyncio.sleep(0)
    return {"sum": payload["a"] + payload["b"]}
`,
        {
          execution: { language: "python", network: "sandbox", sourceLanguage: "python" },
          inputSchema: {
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
            type: "object",
          },
          outputSchema: { properties: { sum: { type: "number" } }, type: "object" },
        },
      );
      const { execute } = withExecutor(tool, { manager: localSandbox(root, calls) });

      const result = await execute(hostedCodeRequest({ a: 2, b: 3 }), tool.definition);

      expect(result.output).toMatchObject({ exitCode: 0, output: { sum: 5 }, stdout: "" });
      expect(String(result.output?.stderr)).toContain("adding 2 3");
      const uploads = calls.flatMap((call) => ("upload" in call ? [call.upload] : []));
      const staging = dirname(uploads[0]!.path);
      expect(uploads.map((upload) => upload.path.slice(staging.length + 1))).toEqual([
        "tool.py",
        "input.json",
        "runner.py",
      ]);
      expect(new TextDecoder().decode(uploads[2]!.content)).toBe(HOSTED_CODE_PYTHON_RUNNER);
      const exec = calls.find((call) => "exec" in call);
      expect(exec).toMatchObject({ exec: { command: ["python3", `${staging}/runner.py`] } });
      expect(exec && "exec" in exec ? exec.exec : {}).not.toHaveProperty("network");
      expect(exec && "exec" in exec ? exec.exec.env : {}).toEqual({});
      expect(existsSync(join(root, staging))).toBe(false);
    },
    GUEST_RUN_TIMEOUT_MS,
  );

  test(
    "reports a raised Python exception as a completed non-zero result",
    async () => {
      const tool = hostedCodeTool(`def handler(payload):\n    raise KeyError("sku")\n`, {
        execution: { language: "python", sourceLanguage: "python" },
      });
      const { execute } = withExecutor(tool, { manager: localSandbox(root) });

      const result = await execute(hostedCodeRequest({ orderId: "ord_9" }), tool.definition);

      expect(result.output).toMatchObject({
        error: { message: "'sku'", name: "KeyError" },
        exitCode: 1,
      });
    },
    GUEST_RUN_TIMEOUT_MS,
  );

  test(
    "redacts a non-ASCII secret the Python handler returns",
    async () => {
      const secret = "pässwörd-ключ-🔑";
      const tool = hostedCodeTool(
        `import os\n\n\ndef handler(payload):\n    return {"echoed": os.environ["ORDERS_TOKEN"]}\n`,
        {
          credential: { credentialId: "01ARZ3NDEKTSV4RRFFQ69G5FC9", generation: 1 },
          execution: {
            language: "python",
            secretNames: ["ORDERS_TOKEN"],
            sourceLanguage: "python",
          },
        },
      );
      const { execute } = withExecutor(tool, {
        manager: localSandbox(root),
        readSecrets: async () => ({ ORDERS_TOKEN: secret }),
      });

      const result = await execute(hostedCodeRequest({}), tool.definition);

      expect(result.output).toMatchObject({ output: { echoed: "[redacted secret]" } });
      expect(JSON.stringify(result)).not.toContain("ключ");
    },
    GUEST_RUN_TIMEOUT_MS,
  );
});
