import { describe, expect, it } from "bun:test";
import type { RuntimeSdk } from "@agentifiers/deployments-sdk";
import type { CliIo } from "../types.ts";
import type { TurnInteraction } from "./prompts.ts";
import { DevRenderer } from "./render.ts";
import { resolveToolResults } from "./turn.ts";

const NOW = Date.parse("2026-09-29T12:00:00.000Z");

function harness(toolCalls: readonly Record<string, unknown>[]) {
  const resolves: { toolCallId: string; body: unknown }[] = [];
  const prompted: string[] = [];
  const output: string[] = [];
  const runtime = {
    toolCalls: {
      list: async () => ({ data: { toolCalls } }),
      resolve: async (_runId: string, toolCallId: string, body: unknown) => {
        resolves.push({ toolCallId, body });
        return { data: {} };
      },
    },
  } as unknown as RuntimeSdk;
  const interaction: TurnInteraction = {
    decideApproval: async () => "approved",
    provideToolResult: async (toolCall) => {
      prompted.push(`server:${toolCall.id}`);
      return { outcome: "completed", outputSummary: '{"ok":true}' };
    },
    provideClientToolResult: async (toolCall) => {
      prompted.push(`client:${toolCall.id}`);
      return { outcome: "completed", output: { answer: 42 } };
    },
  };
  const io = {
    stdout: (text: string) => output.push(text),
    stderr: (text: string) => output.push(text),
  } as unknown as CliIo;
  const options = {
    runtime,
    threadId: "thread_1",
    runId: "run_1",
    renderer: new DevRenderer(io, false),
    interaction,
  };
  return { options, resolves, prompted, output };
}

describe("resolveToolResults", () => {
  it("submits parsed output for a client tool call", async () => {
    const h = harness([
      {
        id: "tc_1",
        status: "running",
        toolName: "pick_file",
        executionType: "client",
        input: { path: "a" },
        expiresAt: "2026-09-29T12:05:00.000Z",
      },
    ]);
    expect(await resolveToolResults(h.options, () => NOW)).toBe(1);
    expect(h.prompted).toEqual(["client:tc_1"]);
    expect(h.resolves).toEqual([
      {
        toolCallId: "tc_1",
        body: { outcome: "completed", output: { answer: 42 }, threadId: "thread_1" },
      },
    ]);
  });

  it("skips an expired client tool call without prompting", async () => {
    const h = harness([
      {
        id: "tc_1",
        status: "running",
        toolName: "pick_file",
        executionType: "client",
        expiresAt: "2026-09-29T12:00:00.000Z",
      },
    ]);
    expect(await resolveToolResults(h.options, () => NOW)).toBe(0);
    expect(h.prompted).toEqual([]);
    expect(h.resolves).toEqual([]);
    expect(h.output.join("\n")).toContain("tc_1");
  });

  it("keeps the summary body for provider tool calls", async () => {
    const h = harness([
      { id: "tc_2", status: "running", toolName: "search", externalOperationId: "op_1" },
    ]);
    expect(await resolveToolResults(h.options, () => NOW)).toBe(1);
    expect(h.resolves).toEqual([
      {
        toolCallId: "tc_2",
        body: {
          externalOperationId: "op_1",
          outcome: "completed",
          outputSummary: '{"ok":true}',
          threadId: "thread_1",
        },
      },
    ]);
  });
});
