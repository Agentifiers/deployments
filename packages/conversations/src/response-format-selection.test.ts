import { agentManifestContentHash, type AgentResponseFormat } from "@deployments-ai/agent-manifest";
import { AgentReleaseRecord, withCanonicalRecordKeys } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  controlFixtures,
  deploymentId,
  environmentId,
  idGenerator,
  memoryDatabase,
  now,
  organizationId,
  projectId,
  releaseId,
} from "./conversation-control.fixture.ts";
import { createConversationService } from "./index.ts";

const releaseFormat: AgentResponseFormat = {
  name: "answer",
  schema: {
    properties: { answer: { type: "string" }, confidence: { type: "number" } },
    required: ["answer"],
    type: "object",
  },
  type: "json_schema",
};

function serviceWithReleaseFormat() {
  const fixtures = controlFixtures();
  const manifest = {
    ...fixtures.release.data.manifest,
    spec: {
      ...fixtures.release.data.manifest.spec,
      runtime: { responseFormat: releaseFormat },
    },
  };
  const release = Schema.decodeUnknownSync(AgentReleaseRecord)(
    withCanonicalRecordKeys({
      ...fixtures.release,
      data: { ...fixtures.release.data, contentHash: agentManifestContentHash(manifest), manifest },
    }),
  );
  const memory = memoryDatabase([fixtures.deployment, release]);
  const service = createConversationService({
    database: memory.database,
    enqueueRun: async () => {},
    generateId: idGenerator(),
    now: () => now,
  });
  const submit = (
    idempotencyKey: string,
    extra: { readonly responseFormat?: AgentResponseFormat; readonly trigger?: string } = {},
  ) =>
    service.submitTurn({
      actor: { type: "system" },
      agentDeploymentId: deploymentId,
      agentReleaseId: releaseId,
      content: "Answer the question.",
      environmentId,
      idempotencyKey,
      organizationId,
      projectId,
      ...extra,
    });
  return { memory, submit };
}

describe("release-pinned response format selection", () => {
  test("persists the release format on runs that do not request one", async () => {
    const { submit } = serviceWithReleaseFormat();
    const created = await submit("release-only");
    expect(created.run.data.responseFormat).toEqual(releaseFormat);
  });

  test("accepts a canonically equal request format and rejects a different one", async () => {
    const { memory, submit } = serviceWithReleaseFormat();
    const reordered: AgentResponseFormat = {
      schema: {
        type: "object",
        required: ["answer"],
        properties: { confidence: { type: "number" }, answer: { type: "string" } },
      },
      type: "json_schema",
      name: "answer",
    };
    const equal = await submit("equal-format", { responseFormat: reordered });
    expect(equal.run.data.responseFormat).toEqual(reordered);

    const transactionsBefore = memory.transactions.length;
    expect(
      submit("conflicting-format", {
        responseFormat: { ...releaseFormat, schema: { type: "array" } },
      }),
    ).rejects.toMatchObject({ code: "response_format_conflict" });
    expect(memory.transactions).toHaveLength(transactionsBefore);
  });

  test("does not apply the release format to heartbeat or schedule runs", async () => {
    const { submit } = serviceWithReleaseFormat();
    for (const trigger of ["heartbeat", "schedule"]) {
      const automated = await submit(`automated-${trigger}`, { trigger });
      expect(automated.run.data.responseFormat).toBeUndefined();
    }
    const requested: AgentResponseFormat = {
      name: "digest",
      schema: { type: "object" },
      type: "json_schema",
    };
    const scheduled = await submit("scheduled-with-format", {
      responseFormat: requested,
      trigger: "schedule",
    });
    expect(scheduled.run.data.responseFormat).toEqual(requested);
  });
});
