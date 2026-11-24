import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { RunRecord } from "./conversations.ts";
import { withCanonicalRecordKeys } from "./index.ts";

const id = (suffix: string) => `01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}`;
const NOW = "2026-10-07T12:00:00.000Z";
const mediaRun = {
  agentDeploymentId: id("4"),
  agentReleaseId: id("5"),
  attempt: 0,
  captureMode: "metadata-only",
  createdAt: NOW,
  environmentId: id("3"),
  executor: "hosted",
  id: id("6"),
  idempotencyKey: "media-run",
  initiatingCaller: {
    apiCredentialId: id("7"),
    serviceAccountId: id("8"),
    type: "service-account",
  },
  inputArtifacts: [id("9")],
  organizationId: id("1"),
  priority: 0,
  projectId: id("2"),
  redactionPolicyVersion: 1,
  schemaVersion: 1,
  spanId: "0123456789abcdef",
  status: "queued",
  threadId: id("10"),
  traceId: "0123456789abcdef0123456789abcdef",
  trigger: "api",
  updatedAt: NOW,
  userMessageId: id("11"),
  userMessageSequence: 0,
  version: 0,
};
const decodeRun = (data: Readonly<Record<string, unknown>>) =>
  Schema.decodeUnknownSync(RunRecord)(withCanonicalRecordKeys({ data, itemType: "run" }));

describe("run input media ownership", () => {
  test("a run with input artifacts but no initiating caller or prompt message fails RunInputMediaOwnership", () => {
    expect(decodeRun(mediaRun).data.inputArtifacts).toEqual([id("9")]);
    const { initiatingCaller: _caller, ...withoutCaller } = mediaRun;
    const { userMessageId: _message, ...withoutMessage } = mediaRun;
    for (const run of [withoutCaller, withoutMessage]) {
      expect(() => decodeRun(run)).toThrow(
        "Runs with input artifacts carry their initiating caller and prompt message.",
      );
    }
  });
});
