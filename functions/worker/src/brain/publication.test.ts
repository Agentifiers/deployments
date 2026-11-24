import { describe, expect, test } from "bun:test";
import type {
  RuntimeBrainEvidenceContextItem,
  RuntimeCompletedToolCall,
} from "@deployments-ai/agent-runtime";
import {
  makeOrganizationCapacity,
  type DynamoDatabaseService,
  type Ulid,
} from "@deployments-ai/db";
import { fixtures } from "../agent-run.fixture.ts";
import { prepareCompletedRun } from "../agent-run-completion.ts";
import type { AgentRunWorkerDependencies } from "../types.ts";
import { recordingTenantLimitMetrics, testTenantLimits } from "../tenant-limits.fixture.ts";

const brainCall: RuntimeCompletedToolCall = {
  effect: "read",
  idempotencyKey: "brain-search",
  input: { brainIds: ["01J00000000000000000000001"], query: "What changed?" },
  inputSummary: "Search the company Brain",
  outputSummary: "Evidence is available in a private transient artifact.",
  policyAction: "allow",
  policyReason: "Declared release capability",
  requiredScopes: [],
  toolCallId: "01J00000000000000000000002" as Ulid,
  toolName: "agent.brain.search",
};

const activeEvidence: RuntimeBrainEvidenceContextItem = {
  brainId: "01J00000000000000000000001",
  chunkId: "chunk-active",
  coordinates: { end: 12, kind: "utf8-byte", start: 0 },
  documentId: "01J00000000000000000000008",
  documentVersionId: "01J00000000000000000000009",
  excerpt: "Sensitive active recall evidence.",
  renditionId: "01J0000000000000000000000A",
  score: 0.9,
  sensitivity: "confidential",
  sourceId: "01J0000000000000000000000B",
};

function dependencies(
  overrides: Partial<AgentRunWorkerDependencies> = {},
): AgentRunWorkerDependencies {
  const generated = [
    "01J00000000000000000000003",
    "01J00000000000000000000004",
    "01J00000000000000000000005",
    "01J00000000000000000000006",
  ];
  const database = {} as DynamoDatabaseService;
  return {
    database,
    generateId: async () => generated.shift()! as never,
    organizationCapacity: makeOrganizationCapacity(database),
    queueMaxReceiveCount: 900,
    runtime: { generateAssistantMessage: async () => ({ assistantMessage: "unused" }) },
    tenantLimitMetrics: recordingTenantLimitMetrics().metrics,
    tenantLimits: testTenantLimits().resolver,
    workerId: "worker-1",
    ...overrides,
  };
}

describe("Brain answer publication", () => {
  test("fails closed without a disclosure-revalidating private publication adapter", async () => {
    expect(
      prepareCompletedRun(
        dependencies(),
        fixtures().run,
        "Sensitive answer copied from Brain evidence.",
        [brainCall],
        [],
        [],
      ),
    ).rejects.toMatchObject({ code: "brain_publication_unavailable" });
  });

  test("persists only the adapter's safe body and live-read metadata", async () => {
    const plan = await prepareCompletedRun(
      dependencies({
        prepareBrainPublication: async ({ body, brainToolCalls }) => {
          expect(body).toContain("Sensitive answer");
          expect(brainToolCalls).toEqual([brainCall]);
          return {
            body: "Brain answer available at an authenticated private link.",
            messageMetadata: {
              brainIds: ["01J00000000000000000000001"],
              brainPublicationId: "01J00000000000000000000007",
              kind: "brain-private-publication",
            },
          };
        },
      }),
      fixtures().run,
      "Sensitive answer copied from Brain evidence.",
      [brainCall],
      [],
      [],
    );

    expect(plan.body).toBe("Brain answer available at an authenticated private link.");
    expect(plan.messageMetadata).toEqual({
      brainIds: ["01J00000000000000000000001"],
      brainPublicationId: "01J00000000000000000000007",
      deploymentsAiConversationReplay: "excluded",
      kind: "brain-private-publication",
    });
  });

  test("routes automatic Brain recall through the private publication adapter", async () => {
    const plan = await prepareCompletedRun(
      dependencies({
        prepareBrainPublication: async ({ brainEvidence, brainToolCalls }) => {
          expect(brainEvidence).toEqual([activeEvidence]);
          expect(brainToolCalls).toEqual([]);
          return {
            body: "Active Brain answer available at an authenticated private link.",
            messageMetadata: { kind: "brain-private-publication" },
          };
        },
      }),
      fixtures().run,
      "Sensitive answer copied from active Brain recall.",
      [],
      [activeEvidence],
      [],
    );

    expect(plan.body).toContain("authenticated private link");
    expect(plan.messageMetadata).toEqual({
      deploymentsAiConversationReplay: "excluded",
      kind: "brain-private-publication",
    });
  });

  test("validates structured answers without exposing private Brain content inline", async () => {
    const run = fixtures().run;
    const privateAnswer = JSON.stringify({ answer: "Confidential Brain result" });
    const plan = await prepareCompletedRun(
      dependencies({
        prepareBrainPublication: async () => ({
          body: "Read the answer through the authenticated private artifact API.",
          messageMetadata: { kind: "brain-private-publication-link" },
        }),
      }),
      {
        ...run,
        data: {
          ...run.data,
          responseFormat: {
            type: "json_schema",
            name: "answer",
            schema: {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
              additionalProperties: false,
            },
          },
        },
      },
      privateAnswer,
      [brainCall],
      [],
      [],
    );
    expect(plan.body).not.toContain("Confidential Brain result");
    expect(plan.messageMetadata?.deploymentsAiConversationReplay).toBe("excluded");
  });

  test("rejects invalid structured answers before creating a private publication", async () => {
    const run = fixtures().run;
    let published = false;
    expect(
      prepareCompletedRun(
        dependencies({
          prepareBrainPublication: async () => {
            published = true;
            return { body: "Private artifact pointer", messageMetadata: {} };
          },
        }),
        {
          ...run,
          data: {
            ...run.data,
            responseFormat: { type: "json_schema", name: "answer", schema: { type: "object" } },
          },
        },
        "Not JSON",
        [brainCall],
        [],
        [],
      ),
    ).rejects.toThrow("invalid JSON");
    expect(published).toBe(false);
  });
});
