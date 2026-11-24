import { describe, expect, it } from "bun:test";
import { RuntimeArtifactPublicationError } from "./errors.ts";
import {
  MAX_SANDBOX_FAILURE_MESSAGE_BYTES,
  boundedSandboxFailureMessage,
  recordArtifacts,
  rehydrateContinuedArtifacts,
  validateRuntimeArtifactContinuation,
} from "./runtime-artifacts.ts";
import { input } from "./runtime.fixture.ts";

describe("runtime artifact state", () => {
  it("classifies unexpected recorder failures as retryable publication errors", async () => {
    expect(
      recordArtifacts(
        input(),
        {
          generateAssistantMessage: async () => ({ assistantMessage: "unused" }),
          recordArtifact: async () => {
            throw new Error("storage unavailable");
          },
        },
        [{ content: "body", fileName: "result.txt", label: "Result" }],
      ),
    ).rejects.toBeInstanceOf(RuntimeArtifactPublicationError);
  });

  it("uses canonical artifact metadata for persistence and runtime state", async () => {
    const recorded: unknown[] = [];
    const retained: unknown[] = [];
    await recordArtifacts(
      input(),
      {
        generateAssistantMessage: async () => ({ assistantMessage: "unused" }),
        recordArtifact: async (artifact) => void recorded.push(artifact),
      },
      [
        {
          content: "body\ud800",
          contentType: " text/\ud800plain ",
          fileName: "logs/\ud800output.txt",
          label: " Result\ud800 ",
          type: " log\ud800 ",
          visibility: "private",
        },
      ],
      0,
      (artifact) => void retained.push(artifact),
    );

    expect(recorded).toEqual(retained);
    expect(recorded).toEqual([
      {
        content: "body�",
        contentType: "text/�plain",
        fileName: "logs-�output.txt",
        label: "Result�",
        type: "log�",
        visibility: "private",
      },
    ]);
  });

  it("rejects oversized continuation fields and aggregate metadata", () => {
    expect(
      validateRuntimeArtifactContinuation({
        artifactBytes: 0,
        artifactIndexCursor: 1,
        artifacts: [
          {
            contentType: " text/plain ",
            fileName: "logs/output.txt",
            label: " Result ",
            type: " log ",
          },
        ],
      }),
    ).toMatchObject({
      artifacts: [
        {
          contentType: "text/plain",
          fileName: "logs-output.txt",
          label: "Result",
          type: "log",
        },
      ],
    });

    expect(() =>
      validateRuntimeArtifactContinuation({
        artifactBytes: 0,
        artifactIndexCursor: 1,
        artifacts: [{ fileName: "result.txt", label: "x".repeat(513) }],
      }),
    ).toThrow("label exceeds 512 UTF-8 bytes");

    expect(() =>
      validateRuntimeArtifactContinuation({
        artifactBytes: 0,
        artifactIndexCursor: 32,
        artifacts: Array.from({ length: 32 }, (_, index) => ({
          contentType: "x".repeat(256),
          fileName: `${String(index).padStart(3, "0")}-${"f".repeat(236)}`,
          label: "l".repeat(512),
          type: "t".repeat(128),
        })),
      }),
    ).toThrow("metadata exceeds 32768 bytes");
  });

  it("bounds combined sandbox failures by UTF-8 bytes", () => {
    const message = boundedSandboxFailureMessage([
      `Execution: ${"😀".repeat(1_000)}`,
      `Cleanup: ${"x".repeat(1_000)}`,
      `Artifacts: ${"y".repeat(1_000)}`,
    ]);

    expect(new TextEncoder().encode(message).byteLength).toBeLessThanOrEqual(
      MAX_SANDBOX_FAILURE_MESSAGE_BYTES,
    );
    expect(message.endsWith("...")).toBe(true);
  });

  it("rehydrates an artifact after its visibility is widened", async () => {
    const loaded = await rehydrateContinuedArtifacts(
      input(),
      {
        generateAssistantMessage: async () => ({ assistantMessage: "unused" }),
        loadArtifact: async () => ({
          content: "shared body",
          fileName: "result.txt",
          label: "Result",
          visibility: "organization",
        }),
      },
      {
        artifactBytes: new TextEncoder().encode("shared body").byteLength,
        artifactIndexCursor: 1,
        artifacts: [
          {
            contentType: "application/octet-stream",
            fileName: "result.txt",
            label: "Result",
            type: "report",
            visibility: "private",
          },
        ],
      },
    );

    expect(loaded?.[0]?.visibility).toBe("organization");

    expect(
      rehydrateContinuedArtifacts(
        input(),
        {
          generateAssistantMessage: async () => ({ assistantMessage: "unused" }),
          loadArtifact: async () => ({
            content: "shared body",
            fileName: "result.txt",
            label: "Result",
            visibility: "private",
          }),
        },
        {
          artifactBytes: new TextEncoder().encode("shared body").byteLength,
          artifactIndexCursor: 1,
          artifacts: [
            {
              fileName: "result.txt",
              label: "Result",
              visibility: "organization",
            },
          ],
        },
      ),
    ).rejects.toThrow("does not match its continuation metadata");
  });
});
