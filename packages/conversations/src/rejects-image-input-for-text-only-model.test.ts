import { ThreadRecord, withCanonicalRecordKeys } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  controlFixtures,
  deploymentId,
  environmentId,
  idGenerator,
  ids,
  inputArtifact,
  memoryDatabase,
  now,
  organizationId,
  projectId,
} from "./conversation-control.fixture.ts";
import { createConversationService } from "./index.ts";

const personId = ids[23]!;
const threadId = ids[21]!;
const person = { principalId: personId, type: "principal" } as const;
const image = inputArtifact({ contentType: "image/png", id: ids[22]!, owner: person, threadId });
const audio = inputArtifact({ contentType: "audio/wav", id: ids[24]!, owner: person, threadId });

function submitWithModel(modelId: string, artifactId: string) {
  const fixtures = controlFixtures({ model: { id: modelId } });
  const thread = Schema.decodeUnknownSync(ThreadRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: deploymentId,
        archived: false,
        channel: "api",
        createdAt: now.toISOString(),
        createdBy: { id: personId, type: "principal" as const },
        environmentId,
        id: threadId,
        organizationId,
        pinned: false,
        projectId,
        streamId: ids[25]!,
        title: "Media thread",
        updatedAt: now.toISOString(),
        version: 0,
      },
      itemType: "thread" as const,
    }),
  );
  const memory = memoryDatabase([fixtures.deployment, fixtures.release, thread, image, audio]);
  return createConversationService({
    database: memory.database,
    enqueueRun: async () => {},
    generateId: idGenerator(),
    now: () => now,
  }).submitTurn({
    actor: { id: personId, type: "principal" },
    agentDeploymentId: deploymentId,
    content: "What does this say?",
    environmentId,
    idempotencyKey: `media-${modelId}`,
    initiatingCaller: { principalId: personId, scopes: ["runs:write"], type: "principal" },
    inputArtifacts: [artifactId],
    organizationId,
    projectId,
    threadId,
  });
}

describe("image input admission", () => {
  test("image input to a release whose primary model cannot read images fails with model_image_input_unsupported", async () => {
    expect(submitWithModel("openrouter/z-ai/glm-5.2", image.data.id)).rejects.toMatchObject({
      code: "model_image_input_unsupported",
    });
  });

  test("image input to a release whose primary model has unknown image capability fails with model_image_input_unknown", async () => {
    expect(
      submitWithModel("openrouter/vendor/operator-granted", image.data.id),
    ).rejects.toMatchObject({ code: "model_image_input_unknown" });
  });

  test("audio-only input is unaffected by the model's image capability", async () => {
    const submitted = await submitWithModel("openrouter/z-ai/glm-5.2", audio.data.id);

    expect(submitted.created).toBe(true);
    expect(submitted.run.data.inputArtifacts).toEqual([audio.data.id]);
  });
});
