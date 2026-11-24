import { ThreadRecord, withCanonicalRecordKeys } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  controlFixtures,
  deploymentId,
  environmentId,
  idGenerator,
  ids,
  memoryDatabase,
  now,
  organizationId,
  projectId,
} from "./conversation-control.fixture.ts";
import { createConversationService } from "./index.ts";

const personId = ids[23]!;
const threadId = ids[21]!;

function thread(title: string, version: number, channel = "api") {
  return Schema.decodeUnknownSync(ThreadRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: deploymentId,
        archived: false,
        channel,
        createdAt: now.toISOString(),
        createdBy: { id: personId, type: "principal" as const },
        environmentId,
        id: threadId,
        organizationId,
        pinned: false,
        projectId,
        streamId: ids[25]!,
        title,
        updatedAt: now.toISOString(),
        version,
      },
      itemType: "thread" as const,
    }),
  );
}

async function submitTo(existing: ReturnType<typeof thread>) {
  const fixtures = controlFixtures();
  const memory = memoryDatabase([fixtures.deployment, fixtures.release, existing]);
  const submitted = await createConversationService({
    database: memory.database,
    enqueueRun: async () => {},
    generateId: idGenerator(),
    now: () => now,
  }).submitTurn({
    actor: { id: personId, type: "principal" },
    agentDeploymentId: deploymentId,
    content: "Where is my refund?\nOrder 1042, paid by card.",
    environmentId,
    idempotencyKey: "thread-title",
    organizationId,
    projectId,
    threadId,
  });
  return submitted.thread.data;
}

describe("submitting to an existing thread", () => {
  test("the first message titles a thread created without a title", async () => {
    expect((await submitTo(thread("New conversation", 0))).title).toBe("Where is my refund?");
  });

  test("a thread created with a title keeps it", async () => {
    expect((await submitTo(thread("Refund follow-up", 0))).title).toBe("Refund follow-up");
  });

  test("a later message does not retitle a thread", async () => {
    expect((await submitTo(thread("New conversation", 3))).title).toBe("New conversation");
  });

  test("a thread started in the console keeps its channel", async () => {
    expect((await submitTo(thread("New conversation", 0, "console"))).channel).toBe("console");
  });
});
