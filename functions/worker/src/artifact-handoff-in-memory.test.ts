import { describe, expect, test } from "bun:test";
import type { DynamoDatabaseService, Ulid } from "@deployments-ai/db";
import { PROVIDER_NATIVE_ARTIFACT_HANDOFF_INPUT_KEY } from "@deployments-ai/tools";
import {
  assertSourceMatchesHandoffIntent,
  canonicalProviderHandoff,
  providerHandoffInputHash,
  type ProviderHandoffIntent,
} from "./artifact-handoff-runtime.ts";
import { loadSourceToolCall } from "./artifact-lifecycle-runtime-tools.ts";

const id = (suffix: string) => `01J000000000000000000000${suffix}` as Ulid;
const sourceToolCallId = id("10");
const intentId = id("11");
const artifactId = id("12");
const providerInput = { body: { subject: "Report", content: "Send {{artifact.url}}" } };
const intent: ProviderHandoffIntent = {
  artifactId,
  createdAt: "2026-07-29T01:00:00.000Z",
  expiresAt: "2026-07-29T02:00:00.000Z",
  intentId,
  provider: "sendgrid",
  providerInputHash: providerHandoffInputHash(providerInput),
  reservedAt: "2026-07-29T01:01:00.000Z",
  reservedByToolCallId: sourceToolCallId,
  toolName: "sendgrid.email.send",
};

describe("artifact handoff in-memory completion", () => {
  test("uses a prior completed provider call before terminal persistence", async () => {
    let reads = 0;
    const source = await loadSourceToolCall(
      {
        artifactBucket: "artifacts",
        artifactS3: { send: async () => ({}) } as never,
        database: {
          getRecord: () => {
            reads += 1;
            throw new Error("durable source should not be read");
          },
        } as unknown as DynamoDatabaseService,
        generateId: async () => id("19"),
      },
      {
        agentDefinitionId: id("01"),
        agentDeploymentId: id("02"),
        agentReleaseId: id("03"),
        completedToolCalls: [
          {
            effect: "write",
            idempotencyKey: "provider-write",
            input: {
              ...providerInput,
              [PROVIDER_NATIVE_ARTIFACT_HANDOFF_INPUT_KEY]: { artifactId, intentId },
            },
            inputSummary: "Send artifact",
            outputSummary: "Sent email",
            policyAction: "allow",
            policyReason: "approved",
            requiredScopes: [],
            toolCallId: sourceToolCallId,
            toolName: "sendgrid.email.send",
          },
        ],
        decision: { action: "allow", reason: "test", toolCallId: id("09") },
        effect: "write",
        environmentId: id("04"),
        idempotencyKey: "record-result",
        inputSummary: "Record result",
        organizationId: id("05"),
        projectId: id("06"),
        requiredScopes: [],
        runId: id("07"),
        threadId: id("08"),
        toolName: "artifact.provider_handoffs.record_result",
      },
      sourceToolCallId,
      intent,
    );

    assertSourceMatchesHandoffIntent(source, intent);
    expect(canonicalProviderHandoff(source, intent, "2026-07-29T01:02:00.000Z")).toMatchObject({
      externalStatus: "succeeded",
      outputSummary: "Sent email",
      sourceToolCallId,
    });
    expect(reads).toBe(0);
  });
});
