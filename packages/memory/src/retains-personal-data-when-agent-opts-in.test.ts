import { describe, expect, it } from "bun:test";
import { fixedNow, grantedFlushRun, memoryDatabase } from "./memory-flush-test-fixtures.ts";
import { fakeMemorySearchProvider } from "./memory-search-test-fixtures.ts";
import { makeMemoryPlatform } from "./platform.ts";
import { memorySynchronizationGeneration } from "./platform-shared.ts";
import { ids } from "./test-fixtures.ts";

const scope = {
  environmentId: ids.environment,
  organizationId: ids.organization,
  projectId: ids.project,
  workspaceId: ids.workspace,
};

const contact = "Bloom & Vine's contact is hello@bloomvine.example, 602-555-0110.";
const allergy = "Guest Ana has a peanut allergy.";
const secret = "The vendor portal password = hunter2-portal-secret-9f3k.";

async function flushed(transcriptPrivacy: "redact" | "retain") {
  const { database, put } = memoryDatabase();
  const search = fakeMemorySearchProvider();
  const platform = makeMemoryPlatform({
    database,
    embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
    now: () => fixedNow,
    searchProvider: {
      ...search.provider,
      readiness: async () => ({
        denseReady: true,
        lexicalReady: true,
        reference: "test",
        ready: true,
        schemaReady: true,
      }),
    },
  });
  const space = await platform.createMemorySpace(scope, { name: "Agent memory" });
  await platform.upsertPolicy(scope, { activeRecallEnabled: true });
  const run = await grantedFlushRun(platform, put, scope, space.data.id);
  const flush = await platform.enqueueFlush(scope, run, {
    memoryMode: "agent",
    memorySpaceId: space.data.id,
    reviewMode: "auto-approve",
  });
  const result = await platform.importFlushCandidates(scope, {
    candidates: [contact, allergy, secret].map((content) => ({ content, scope: "agent" as const })),
    flushId: flush.data.id,
    memoryMode: "agent",
    memorySpaceId: space.data.id,
    reviewMode: "auto-approve",
    run,
    transcriptPrivacy,
  });
  for (const memory of result.imported) {
    await platform.processIndexJob(scope, {
      idempotencyKey: `${memory.data.id}:${memory.data.version}:${memorySynchronizationGeneration(memory)}:index`,
      memoryId: memory.data.id,
    });
  }
  const recalled = await platform.search(scope, {
    memorySpaceIds: [space.data.id],
    purpose: "active-recall",
    query: "What do we know about the vendors and guests?",
    runId: ids.run,
    allowedScopeKeys: [`agent:${ids.agent}`],
    searchKeys: [`agent:${ids.agent}`],
    threadId: ids.thread,
  });
  return {
    recalled: recalled.results
      .map((entry) => entry.memory.data.body ?? "")
      .toSorted((a, b) => a.localeCompare(b)),
    rejected: result.rejected.map((entry) => entry.reason),
    stored: result.imported.map((memory) => ({
      body: memory.data.body,
      retainsPersonalData: memory.data.retainsPersonalData,
      reviewStatus: memory.data.reviewStatus,
    })),
  };
}

describe("an agent that retains personal data in memory", () => {
  it("stores and recalls contact and health details verbatim, and still rejects secrets", async () => {
    expect(await flushed("retain")).toEqual({
      recalled: [contact, allergy].toSorted((a, b) => a.localeCompare(b)),
      rejected: ["Memory content contains secret-like material."],
      stored: [
        { body: contact, retainsPersonalData: true, reviewStatus: "approved" },
        { body: allergy, retainsPersonalData: true, reviewStatus: "approved" },
      ],
    });
  });

  it("keeps redacting and withholding the same memories without the opt-in", async () => {
    const redacted = "Bloom & Vine's contact is [redacted email], [redacted phone].";
    expect(await flushed("redact")).toEqual({
      recalled: [redacted],
      rejected: ["Memory content contains secret-like material."],
      stored: [
        { body: redacted, retainsPersonalData: undefined, reviewStatus: "approved" },
        { body: allergy, retainsPersonalData: undefined, reviewStatus: "approved" },
      ],
    });
  });
});
