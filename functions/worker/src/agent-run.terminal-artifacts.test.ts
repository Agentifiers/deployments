import { describe, expect, it } from "bun:test";
import {
  fixtures,
  id,
  inMemoryDatabase,
  manifestWithToolRequests,
  releaseWithManifest,
  workerDependencies,
} from "./agent-run.fixture.ts";
import { runToolContinuation } from "./continuation.ts";
import { processAgentRun } from "./index.ts";
import type { AgentRunWorkerDependencies } from "./types.ts";

function releaseWithArtifactTool(fixture: ReturnType<typeof fixtures>) {
  return releaseWithManifest(
    fixture.release,
    manifestWithToolRequests(fixture.release.data.manifest, [
      {
        effect: "read",
        idempotencyKey: "tool/terminal-artifact",
        inputSummary: "Collect terminal evidence.",
        requiredScopes: ["evidence:read"],
        toolName: "evidence.read",
      },
    ]),
  );
}

function runtimeWithArtifact(options: {
  readonly cancelAfterTool?: boolean;
  readonly oversized?: boolean;
}) {
  let canceled = false;
  return {
    authorizeToolCall: async () => ({
      action: "allow" as const,
      reason: "Allowed by test policy.",
      toolCallId: id(80),
    }),
    executeToolCall: async () => {
      canceled = options.cancelAfterTool ?? false;
      return {
        artifacts: [
          {
            content: "terminal evidence",
            fileName: "terminal-evidence.txt",
            label: "Terminal evidence",
          },
        ],
        outputSummary: "Evidence collected.",
        status: "completed" as const,
      };
    },
    generateAssistantMessage: async () => ({
      assistantMessage: options.oversized ? "x".repeat(300_000) : "Completed.",
    }),
    recordArtifact: async () => undefined,
    resolveToolDefinition: async (toolName: string) => ({
      effect: "read" as const,
      requiredScopes: ["evidence:read"],
      toolName,
    }),
    shouldCancel: async () => canceled,
  };
}

function expectedArtifactContinuation() {
  return {
    artifactBytes: "terminal evidence".length,
    artifactIndexCursor: 1,
    artifacts: [
      {
        contentType: "application/octet-stream",
        fileName: "terminal-evidence.txt",
        label: "Terminal evidence",
        type: "report",
      },
    ],
    sandboxCompleted: true,
  };
}

describe("terminal agent run artifact continuation", () => {
  it("preserves recorded artifacts when cancellation wins after a tool completes", async () => {
    const fixture = fixtures();
    const release = releaseWithArtifactTool(fixture);
    const memory = inMemoryDatabase([
      release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const base = workerDependencies(memory.database);
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: runtimeWithArtifact({ cancelAfterTool: true }),
    };

    const result = await processAgentRun(fixture.queue, dependencies);

    expect(result).toMatchObject({ action: "skipped", run: { data: { status: "canceled" } } });
    if (!result.run) throw new Error("Expected a canceled run result.");
    expect(runToolContinuation(result.run).artifactContinuation).toEqual(
      expectedArtifactContinuation(),
    );
  });

  it("preserves recorded artifacts when completion validation terminalizes the run", async () => {
    const fixture = fixtures();
    const release = releaseWithArtifactTool(fixture);
    const memory = inMemoryDatabase([
      release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const base = workerDependencies(memory.database);
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: runtimeWithArtifact({ oversized: true }),
    };

    const result = await processAgentRun(fixture.queue, dependencies);

    expect(result).toMatchObject({ action: "skipped", run: { data: { status: "failed" } } });
    if (!result.run) throw new Error("Expected a failed run result.");
    expect(runToolContinuation(result.run).artifactContinuation).toEqual(
      expectedArtifactContinuation(),
    );
  });
});
