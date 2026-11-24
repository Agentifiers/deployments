import { describe, expect, it } from "bun:test";
import {
  dataBoundaryOf,
  OrganizationDataBoundary,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { processAgentRun, resolveRunApproval } from "./index.ts";
import { createRuntimeToolService } from "./runtime-tool-authorization.ts";
import type { AgentRunWorkerDependencies } from "./types.ts";
import {
  fixtures,
  id,
  inMemoryDatabase,
  manifestWithToolRequests,
  manifestWithTriggers,
  releaseWithManifest,
  workerDependencies,
} from "./agent-run.fixture.ts";

const DESTINATION = `https://labs.example.org/results?patient=Jane%20Doe&note=${"x".repeat(240)}`;

describe("a phi run that scrapes an unlisted URL", () => {
  it("pauses with the full destination on the approval and runs once a person approves", async () => {
    const fixture = fixtures();
    const release = releaseWithManifest(
      fixture.release,
      manifestWithTriggers(
        manifestWithToolRequests(fixture.release.data.manifest, [
          {
            effect: "read",
            idempotencyKey: "tool/scrape-lab",
            input: { url: DESTINATION },
            inputSummary: "Scrape the lab results page.",
            requiredScopes: [],
            toolName: "web.scrape",
          },
        ]),
        ["api"],
      ),
    );
    const memory = inMemoryDatabase([
      release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const base = workerDependencies(memory.database);
    const scraped: unknown[] = [];
    const tools = createRuntimeToolService({
      builtinExecutors: {
        "web.scrape": async (request) => {
          scraped.push(request.input);
          return { outputSummary: "Scraped the lab results.", status: "completed" };
        },
      },
      dataBoundaries: {
        read: async () =>
          dataBoundaryOf(
            Schema.decodeUnknownSync(OrganizationDataBoundary)({
              operatorNote: "BAA-2026-17",
              profile: "phi",
              setAt: "2026-11-01T00:00:00.000Z",
              setBy: { kind: "operator", principalId: id(90) },
            }),
          ),
      },
      egressAllowlists: { read: async () => [{ origin: "https://claims.example.com" }] },
      generateId: base.dependencies.generateId,
      resolveAuthorizationContext: async () => undefined,
      resolveProviderCredential: async () => {
        throw new Error("Built-ins never load provider credentials.");
      },
    });
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: {
        ...tools,
        generateAssistantMessage: async () => ({ assistantMessage: "Done." }),
        recordArtifact: async () => undefined,
      },
    };

    const first = await processAgentRun(fixture.queue, dependencies);

    expect(first).toMatchObject({ action: "paused", status: "waiting-for-approval" });
    expect(scraped).toEqual([]);
    const approval = [...memory.records.values()].find(
      (record): record is Extract<PlatformRecord, { readonly itemType: "approval" }> =>
        record.itemType === "approval",
    );
    expect(approval?.data.request).toMatchObject({
      destinations: [DESTINATION],
      toolName: "web.scrape",
    });

    const resolved = await resolveRunApproval(
      {
        approvalId: approval!.data.id as Ulid,
        decision: "approved",
        environmentId: fixture.queue.environmentId,
        organizationId: fixture.queue.organizationId,
        projectId: fixture.queue.projectId,
        resolvedByPrincipalId: id(91),
        runId: fixture.queue.runId,
        threadId: fixture.queue.threadId,
      },
      {
        appendThreadEvent: base.dependencies.appendThreadEvent!,
        database: memory.database,
        enqueueRun: async () => undefined,
        generateId: base.dependencies.generateId,
        now: base.dependencies.now!,
      },
    );
    const second = await processAgentRun(resolved.queueMessage!, dependencies);

    expect(second.action).toBe("completed");
    expect(scraped).toEqual([{ url: DESTINATION }]);
  });
});
