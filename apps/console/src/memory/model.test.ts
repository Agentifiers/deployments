import { describe, expect, test } from "bun:test";
import {
  importRequest,
  memoryExportFile,
  parseQualitySearch,
  parseSpaceSearch,
  policyDraft,
  policyRequest,
  qualitySince,
  reviewRequest,
  searchRequest,
  spaceRequest,
  type MemoryPolicy,
} from "./model.ts";

test("parseSpaceSearch keeps non-default filters, so the default view is the bare path", () => {
  expect(parseSpaceSearch({ grants: "revoked" })).toEqual({ grants: "revoked" });
  expect(parseSpaceSearch({ grants: "all" })).toEqual({ grants: "all" });
  expect(parseSpaceSearch({ grants: "active" })).toEqual({});
  expect(parseSpaceSearch({ grants: ["all"] })).toEqual({});
  expect(parseSpaceSearch({ grants: "all", memories: "deleted" })).toEqual({
    grants: "all",
    memories: "deleted",
  });
  expect(parseSpaceSearch({ memories: "archived" })).toEqual({ memories: "archived" });
  expect(parseSpaceSearch({ memories: "active" })).toEqual({});
  expect(parseSpaceSearch({ memories: "purged" })).toEqual({});
});

test("parseQualitySearch keeps a known window other than the 7-day default", () => {
  expect(parseQualitySearch({ days: 90 })).toEqual({ days: 90 });
  expect(parseQualitySearch({ days: 1 })).toEqual({ days: 1 });
  expect(parseQualitySearch({ days: 7 })).toEqual({});
  expect(parseQualitySearch({ days: 45 })).toEqual({});
  expect(parseQualitySearch({ days: "30" })).toEqual({});
});

test("qualitySince keeps the largest window inside the platform's 90-day cap", () => {
  const now = new Date("2026-10-09T12:00:00.000Z");
  expect(qualitySince(90, now)).toBe("2026-07-11T12:05:00.000Z");
  expect(qualitySince(30, now)).toBe("2026-09-09T12:00:00.000Z");
  expect(qualitySince(1, now)).toBe("2026-10-08T12:00:00.000Z");
});

const POLICY: MemoryPolicy = {
  activeRecallEnabled: true,
  activeRecallRolloutPercent: 25,
  createdAt: "2026-09-01T00:00:00.000Z",
  id: "01ARZ3NDEKTSV4RRFFQ69G600M",
  processingConfig: {
    extraction: { model: "small" },
    memoryRetrieval: { purposes: { search: { candidateK: 40 } }, strategy: "hybrid-rerank-v1" },
  },
  retentionDays: 14,
  retrieval: "hybrid-rerank-v1",
  retrievalSettings: { purposes: { search: { candidateK: 40 } }, strategy: "hybrid-rerank-v1" },
  scope: "organization",
  sensitivityMode: "strict",
  updatedAt: "2026-10-01T00:00:00.000Z",
  version: 3,
};

describe("policyRequest", () => {
  test("creates with the chosen scope and only the strategy as processing config", () => {
    const draft = {
      ...policyDraft(undefined),
      retentionDays: "30",
      retrieval: "dense-v1" as const,
    };
    expect(policyRequest(undefined, draft)).toEqual({
      ok: true,
      request: {
        activeRecallEnabled: false,
        activeRecallRolloutPercent: 100,
        processingConfig: { memoryRetrieval: { strategy: "dense-v1" } },
        retentionDays: 30,
        scope: "environment",
        sensitivityMode: "standard",
      },
    });
  });

  test("an edit repeats every field, keeps the policy's scope, and keeps unrelated config", () => {
    const draft = {
      ...policyDraft(POLICY),
      activeRecallRolloutPercent: "60",
      retrieval: "hybrid-rrf-v1" as const,
    };
    expect(policyRequest(POLICY, draft)).toEqual({
      ok: true,
      request: {
        activeRecallEnabled: true,
        activeRecallRolloutPercent: 60,
        id: "01ARZ3NDEKTSV4RRFFQ69G600M",
        processingConfig: {
          extraction: { model: "small" },
          memoryRetrieval: { purposes: { search: { candidateK: 40 } }, strategy: "hybrid-rrf-v1" },
        },
        retentionDays: 14,
        scope: "organization",
        sensitivityMode: "strict",
      },
    });
  });

  test("returning to the default strategy sends a config without it, so the PUT clears it", () => {
    const strategyOnly: MemoryPolicy = {
      ...POLICY,
      processingConfig: { memoryRetrieval: { strategy: "dense-v1" } },
      retrievalSettings: { strategy: "dense-v1" },
    };
    const result = policyRequest(strategyOnly, {
      ...policyDraft(strategyOnly),
      retrieval: "default",
    });
    expect(result.ok && result.request.processingConfig).toEqual({});
  });

  test("a custom retrieval setting is saved back exactly as the platform holds it", () => {
    const perPurpose = {
      purposes: { search: { strategy: "hybrid-rerank-v1" } },
      strategy: "dense-v1",
    };
    const custom: MemoryPolicy = {
      ...POLICY,
      processingConfig: { extraction: { model: "small" }, memoryRetrieval: perPurpose },
      retrieval: "custom",
      retrievalSettings: perPurpose,
    };
    expect(policyDraft(custom).retrieval).toBe("custom");
    const result = policyRequest(custom, { ...policyDraft(custom), sensitivityMode: "standard" });
    expect(result.ok && result.request.processingConfig).toEqual({
      extraction: { model: "small" },
      memoryRetrieval: perPurpose,
    });
  });

  test("a custom policy keeps its retrieval config whatever strategy the draft names", () => {
    const perPurpose = { purposes: { search: { strategy: "hybrid-rerank-v1" } } };
    const custom: MemoryPolicy = {
      ...POLICY,
      processingConfig: { memoryRetrieval: perPurpose },
      retrieval: "custom",
      retrievalSettings: perPurpose,
    };
    const result = policyRequest(custom, { ...policyDraft(custom), retrieval: "dense-v1" });
    expect(result.ok && result.request.processingConfig).toEqual({
      memoryRetrieval: { purposes: { search: { strategy: "hybrid-rerank-v1" } } },
    });
  });

  test("refuses a rollout or retention out of range, and removing a set retention", () => {
    expect(
      policyRequest(POLICY, { ...policyDraft(POLICY), activeRecallRolloutPercent: "101" }),
    ).toEqual({
      ok: false,
      problem: "Rollout must be a whole number from 0 to 100.",
    });
    expect(policyRequest(undefined, { ...policyDraft(undefined), retentionDays: "1.5" })).toEqual({
      ok: false,
      problem: "Retention must be a whole number of days from 1 to 3650.",
    });
    expect(policyRequest(POLICY, { ...policyDraft(POLICY), retentionDays: " " })).toEqual({
      ok: false,
      problem: "A policy's retention can be changed but not removed.",
    });
  });
});

describe("spaceRequest", () => {
  test("trims the form and leaves out empty optional fields", () => {
    expect(
      spaceRequest({
        description: "  ",
        kind: "shared",
        name: " Support ",
        retentionDays: "",
        workspaceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      }),
    ).toEqual({
      ok: true,
      request: { kind: "shared", name: "Support" },
    });
    expect(
      spaceRequest({
        description: "Ticket facts",
        kind: "agent",
        name: "Support",
        retentionDays: "90",
        workspaceId: "",
      }),
    ).toEqual({
      ok: true,
      request: { description: "Ticket facts", kind: "agent", name: "Support", retentionDays: 90 },
    });
  });

  test("refuses a blank name and a retention out of range", () => {
    expect(
      spaceRequest({
        description: "",
        kind: "organization",
        name: " ",
        retentionDays: "",
        workspaceId: "",
      }),
    ).toEqual({
      ok: false,
      problem: "Name must be 1 to 160 characters.",
    });
    expect(
      spaceRequest({
        description: "",
        kind: "organization",
        name: "Support",
        retentionDays: "3651",
        workspaceId: "",
      }),
    ).toEqual({ ok: false, problem: "Retention must be a whole number of days from 1 to 3650." });
  });

  test("sends the owning workspace only for a workspace space, and requires it there", () => {
    const draft = { description: "", name: "Team", retentionDays: "" };
    expect(spaceRequest({ ...draft, kind: "workspace", workspaceId: "" })).toEqual({
      ok: false,
      problem: "Choose the workspace that owns the space.",
    });
    expect(
      spaceRequest({ ...draft, kind: "workspace", workspaceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
    ).toEqual({
      ok: true,
      request: { kind: "workspace", name: "Team", workspaceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    });
  });
});

describe("reviewRequest", () => {
  test("sends content only with an edit and drops a blank reason", () => {
    expect(reviewRequest({ content: " ignored ", decision: "approve", reason: " " })).toEqual({
      ok: true,
      request: { decision: "approve" },
    });
    expect(
      reviewRequest({ content: " Ships on Fridays. ", decision: "edit", reason: " corrected " }),
    ).toEqual({
      ok: true,
      request: { content: "Ships on Fridays.", decision: "edit", reason: "corrected" },
    });
  });

  test("refuses an edit with no content", () => {
    expect(reviewRequest({ content: "  ", decision: "edit", reason: "" })).toEqual({
      ok: false,
      problem: "An edit needs the replacement content.",
    });
  });
});

describe("importRequest", () => {
  const id = "01ARZ3NDEKTSV4RRFFQ69G600K";
  const space = { id };

  test("makes one organization memory per blank-line-separated block, whitespace collapsed", () => {
    expect(
      importRequest(space, {
        memoryType: "fact",
        text: "Ships on Thursdays.\nAfter standup.\n\n  \n Uses Bun. \n",
      }),
    ).toEqual({
      ok: true,
      request: {
        data: [
          {
            content: "Ships on Thursdays. After standup.",
            memoryType: "fact",
            scope: "organization",
          },
          { content: "Uses Bun.", memoryType: "fact", scope: "organization" },
        ],
        memorySpaceId: id,
      },
    });
    expect(importRequest(space, { memoryType: "unset", text: "One." })).toEqual({
      ok: true,
      request: { data: [{ content: "One.", scope: "organization" }], memorySpaceId: id },
    });
  });

  test("scopes each memory to a workspace space's workspace, as the platform requires", () => {
    const workspaceId = "01ARZ3NDEKTSV4RRFFQ69G600P";
    expect(importRequest({ id, workspaceId }, { memoryType: "unset", text: "One." })).toEqual({
      ok: true,
      request: {
        data: [{ content: "One.", scope: "workspace", workspaceId }],
        memorySpaceId: id,
      },
    });
  });

  test("refuses an empty import and one over 100 memories", () => {
    expect(importRequest(space, { memoryType: "unset", text: " \n\n " })).toEqual({
      ok: false,
      problem: "Enter at least one memory.",
    });
    const text = Array.from({ length: 101 }, (_, index) => `Memory ${index}`).join("\n\n");
    expect(importRequest(space, { memoryType: "unset", text })).toEqual({
      ok: false,
      problem: "An import takes at most 100 memories; this has 101.",
    });
    const long = "é".repeat(4001);
    expect(importRequest(space, { memoryType: "unset", text: `Short.\n\n${long}` })).toEqual({
      ok: false,
      problem: "Block 2 is 8,002 bytes; each memory takes at most 8,000 bytes.",
    });
  });

  test("measures each block after collapsing whitespace, as the platform does", () => {
    const spaced = Array.from({ length: 1000 }, () => "note").join(" \t \n ");
    expect(new TextEncoder().encode(spaced).byteLength).toBe(8995);
    expect(importRequest(space, { memoryType: "unset", text: spaced })).toEqual({
      ok: true,
      request: {
        data: [
          { content: Array.from({ length: 1000 }, () => "note").join(" "), scope: "organization" },
        ],
        memorySpaceId: id,
      },
    });
  });
});

describe("searchRequest", () => {
  const draft = {
    memorySpaceIds: ["01ARZ3NDEKTSV4RRFFQ69G600K"],
    mode: "policy" as const,
    query: " release day ",
    topK: "10",
  };

  test("uses the policy's strategy unless one is named", () => {
    expect(searchRequest(draft)).toEqual({
      ok: true,
      request: {
        body: { memorySpaceIds: ["01ARZ3NDEKTSV4RRFFQ69G600K"], query: "release day", topK: 10 },
        kind: "policy",
      },
    });
    expect(searchRequest({ ...draft, mode: "dense-exact-control-v1" })).toEqual({
      ok: true,
      request: {
        body: {
          memorySpaceIds: ["01ARZ3NDEKTSV4RRFFQ69G600K"],
          query: "release day",
          strategy: "dense-exact-control-v1",
          topK: 10,
        },
        kind: "strategy",
      },
    });
  });

  test("names the first missing or out-of-range field", () => {
    expect(searchRequest({ ...draft, query: " " })).toEqual({
      ok: false,
      problem: "Enter a query.",
    });
    expect(searchRequest({ ...draft, memorySpaceIds: [] })).toEqual({
      ok: false,
      problem: "Choose 1 to 20 spaces.",
    });
    expect(searchRequest({ ...draft, topK: "46" })).toEqual({
      ok: false,
      problem: "Results must be a whole number from 1 to 45.",
    });
  });
});

describe("memoryExportFile", () => {
  test("names the file by space and day and records whether the export is whole", () => {
    const file = memoryExportFile(
      "01ARZ3NDEKTSV4RRFFQ69G600K",
      { complete: false, memories: [{ id: "01M4FM00000000000000000001", status: "active" }] },
      new Date("2026-10-09T10:15:00.000Z"),
    );
    expect(file.filename).toBe("memory-01ARZ3NDEKTSV4RRFFQ69G600K-2026-10-09.json");
    expect(JSON.parse(file.content)).toEqual({
      complete: false,
      exportedAt: "2026-10-09T10:15:00.000Z",
      format: "json",
      memories: [{ id: "01M4FM00000000000000000001", status: "active" }],
      memorySpaceId: "01ARZ3NDEKTSV4RRFFQ69G600K",
    });
  });
});
