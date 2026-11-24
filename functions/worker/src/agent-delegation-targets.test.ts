import { describe, expect, test } from "bun:test";
import {
  key,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import {
  assertDeclaredDelegationAllowed,
  selectDeclaredTarget,
  type DeclaredDelegation,
} from "./agent-delegation-targets.ts";

const ids = Array.from(
  { length: 20 },
  (_, index) => `01J000000000000000000000${String(index).padStart(2, "0")}` as Ulid,
);
const [organizationId, projectId, environmentId] = [ids[0]!, ids[1]!, ids[2]!];
const request = {
  agentDefinitionId: ids[4]!,
  agentDeploymentId: ids[5]!,
  agentReleaseId: ids[6]!,
  decision: { action: "allow" as const, reason: "test", toolCallId: ids[7]! },
  effect: "execute" as const,
  environmentId,
  idempotencyKey: "delegate",
  inputSummary: "Delegate",
  organizationId,
  projectId,
  requiredScopes: [],
  runId: ids[8]!,
  threadId: ids[9]!,
  toolName: "agent.delegate",
};
const researcher = {
  agentKey: "research.agent",
  awaitResult: true,
  description: "Researches.",
  key: "researcher",
  required: true,
};
const declared: DeclaredDelegation = {
  agents: [researcher, { ...researcher, awaitResult: false, key: "writer", required: false }],
  bindings: { researcher: { agentDeploymentId: ids[10]! } },
};

function raw(itemType: PlatformRecord["itemType"], data: Record<string, unknown>) {
  return { data, itemType, pk: "test", sk: "test" } as unknown as PlatformRecord;
}

function database(records: Readonly<Record<string, PlatformRecord>>): DynamoDatabaseService {
  return {
    deleteRecord: async () => {},
    getRecord: async (_table, recordKey) => records[recordKey.sk],
    putRecord: async () => {},
    queryRecords: async () => ({ items: [] }),
    transactWrite: async () => {},
  };
}

const scope = { environmentId, organizationId, projectId };
const target = raw("agent-deployment", {
  ...scope,
  agentReleaseId: ids[11],
  id: ids[10],
}) as Extract<PlatformRecord, { readonly itemType: "agent-deployment" }>;
const targetRelease = raw("agent-release", {
  ...scope,
  id: ids[11],
  manifest: { metadata: { key: "research.agent" }, spec: {} },
});

function link(depth: number, ancestors: readonly string[]) {
  return raw("run-delegation", {
    ...scope,
    ancestorAgentDeploymentIds: ancestors,
    childRunId: request.runId,
    depth,
  });
}

describe("declared sub-agent delegation targets", () => {
  test("accepts only declared keys or bound deployment IDs and pins declared edge kinds", () => {
    expect(selectDeclaredTarget(declared, "researcher", undefined)).toMatchObject({
      agentDeploymentId: ids[10],
      awaitResult: true,
      edgeKind: "delegation",
    });
    expect(selectDeclaredTarget(declared, ids[10]!, undefined).agent.key).toBe("researcher");
    expect(() => selectDeclaredTarget(declared, ids[12]!, undefined)).toThrow(
      "not a declared sub-agent",
    );
    expect(() => selectDeclaredTarget(declared, "writer", undefined)).toThrow(
      "not bound in this deployment",
    );
    expect(() => selectDeclaredTarget(declared, "researcher", "handoff")).toThrow(
      "declared with edgeKind delegation",
    );
  });

  test("enforces the declared agent key, maximum depth, and cycle refusal", async () => {
    const selection = selectDeclaredTarget(declared, "researcher", undefined);
    const release = key("AGENT-RELEASE", ids[11]!);
    const runLink = key("RUN-DELEGATION", request.runId);
    expect(
      assertDeclaredDelegationAllowed(
        database({ [release]: targetRelease, [runLink]: link(3, [ids[13]!, ids[14]!, ids[15]!]) }),
        request,
        selection,
        target,
      ),
    ).resolves.toBeUndefined();
    expect(
      assertDeclaredDelegationAllowed(
        database({
          [release]: targetRelease,
          [runLink]: link(4, [ids[13]!, ids[14]!, ids[15]!, ids[16]!]),
        }),
        request,
        selection,
        target,
      ),
    ).rejects.toThrow("maximum of 4");
    expect(
      assertDeclaredDelegationAllowed(
        database({ [release]: targetRelease, [runLink]: link(1, [ids[10]!]) }),
        request,
        selection,
        target,
      ),
    ).rejects.toThrow("cycles are refused");
    expect(
      assertDeclaredDelegationAllowed(
        database({
          [release]: raw("agent-release", {
            ...scope,
            id: ids[11],
            manifest: { metadata: { key: "other.agent" }, spec: {} },
          }),
        }),
        request,
        selection,
        target,
      ),
    ).rejects.toThrow("does not run agent research.agent");
  });
});
