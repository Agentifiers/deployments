import { validateAgentManifest, type AgentManifestV1 } from "@deployments-ai/agent-manifest";
import {
  makeOrganizationStandingRepository,
  makeUniqueClaimRecord,
  OrganizationRecord,
  StandingActor,
  ToolAdapterRecord,
  uniqueClaimRequirements,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { evaluationMemoryDatabase } from "@deployments-ai/db/evaluation-testing";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { makeManifestToolBoundaryAdmission } from "./manifest-tool-admission.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const SCOPE = {
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  organizationId: ORGANIZATION_ID,
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
};
const CREATED_AT = "2026-07-25T12:00:00.000Z";
const OPERATOR = Schema.decodeUnknownSync(StandingActor)({
  kind: "operator",
  principalId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
});

function manifest(toolNames: readonly string[]): AgentManifestV1 {
  const validation = validateAgentManifest({
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: { key: "example.assistant", name: "Example Assistant", version: "1.0.0" },
    spec: {
      capabilities: {
        tools: toolNames.map((name) => ({ name, required: false, requiredScopes: [] })),
      },
      instructions: "Answer the question.",
      model: { id: "bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0" },
      sandbox: { mode: "none" },
    },
  });
  if (!validation.ok) throw new Error(JSON.stringify(validation.issues));
  return validation.manifest;
}

function hostedCodeAdapter(name: string, network: "none" | "sandbox", id: string) {
  return Schema.decodeUnknownSync(ToolAdapterRecord)(
    withCanonicalRecordKeys({
      data: {
        ...SCOPE,
        createdAt: CREATED_AT,
        defaultPolicyAction: "allow",
        description: "Hosted code tool.",
        effect: "read",
        execution: {
          contentHash: `sha256:${"a".repeat(64)}`,
          entrypoint: "handler",
          language: "javascript",
          memoryMiB: 256,
          network,
          secretNames: [],
          sourceLanguage: "javascript",
          timeoutMs: 1_000,
          type: "hosted_code",
        },
        id,
        name,
        requiredScopes: [],
        status: "active",
        updatedAt: CREATED_AT,
        version: 1,
      },
      itemType: "tool-adapter",
    }),
  );
}

async function harness(options: { readonly phi: boolean }) {
  const organization = Schema.decodeUnknownSync(OrganizationRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: CREATED_AT,
        id: ORGANIZATION_ID,
        name: "Clinic",
        slug: "clinic",
        status: "active",
        updatedAt: CREATED_AT,
        version: 1,
      },
      itemType: "organization",
    }),
  );
  const adapters = [
    hostedCodeAdapter("clinic.lookup_offline", "none", "01ARZ3NDEKTSV4RRFFQ69G5FE0"),
    hostedCodeAdapter("clinic.lookup_online", "sandbox", "01ARZ3NDEKTSV4RRFFQ69G5FE1"),
  ];
  const seeded: PlatformRecord[] = [
    organization,
    ...adapters.flatMap((adapter) => [
      adapter,
      ...uniqueClaimRequirements(adapter).map(
        (requirement) => makeUniqueClaimRecord(requirement, CREATED_AT) as PlatformRecord,
      ),
    ]),
  ];
  const memory = evaluationMemoryDatabase(seeded);
  if (options.phi) {
    await makeOrganizationStandingRepository({
      database: memory.database,
      installDefaults: {
        operatorFundedModelSpendCeiling: "unlimited",
        tenantLimits: {
          activeSandboxes: 1,
          apiRequestBurst: 40,
          apiRequestsPerSecond: 20,
          concurrentRuns: 2,
        },
      },
    }).setDataBoundary({
      actor: OPERATOR,
      operatorNote: "BAA on file.",
      organizationId: ORGANIZATION_ID,
      profile: "phi",
    });
  }
  const reads: string[] = [];
  const database: DynamoDatabaseService = {
    ...memory.database,
    getRecord: async (table, key, consistent) => {
      reads.push(key.pk);
      return memory.database.getRecord(table, key, consistent);
    },
  };
  const admit = makeManifestToolBoundaryAdmission({ database });
  return { admit: (toolNames: readonly string[]) => admit(SCOPE, manifest(toolNames)), reads };
}

describe("manifest tool boundary admission", () => {
  test("refuses a public tool whose destinations its input cannot name, at its pointer", async () => {
    const { admit } = await harness({ phi: true });

    expect(await admit(["agent.memory.search", "code.execute"])).toEqual([
      {
        code: "tool_outside_data_boundary",
        message:
          "Tool code.execute can reach public destinations, which this organization's phi data boundary does not allow.",
        path: "/spec/capabilities/tools/1",
      },
    ]);
  });

  test("admits public tools whose calls name their destinations", async () => {
    const { admit } = await harness({ phi: true });

    expect(await admit(["web.scrape", "web.search", "sendgrid.email.send"])).toEqual([]);
  });

  test("admits platform-egress tools", async () => {
    const { admit } = await harness({ phi: true });

    expect(await admit(["agent.memory.search"])).toEqual([]);
  });

  test("refuses a tool name that resolves to nothing, since its egress is unknown", async () => {
    const { admit } = await harness({ phi: true });

    expect(await admit(["clinic.unregistered"])).toEqual([
      {
        code: "tool_outside_data_boundary",
        message: expect.stringContaining("Tool clinic.unregistered is not registered"),
        path: "/spec/capabilities/tools/0",
      },
    ]);
  });

  test("decides hosted code adapters by their network mode", async () => {
    const { admit } = await harness({ phi: true });

    expect(await admit(["clinic.lookup_offline", "clinic.lookup_online"])).toEqual([
      {
        code: "tool_outside_data_boundary",
        message:
          "Tool clinic.lookup_online can reach public destinations, which this organization's phi data boundary does not allow.",
        path: "/spec/capabilities/tools/1",
      },
    ]);
  });

  test("an open organization is admitted from the boundary read alone", async () => {
    const { admit, reads } = await harness({ phi: false });

    expect(await admit(["web.scrape", "clinic.lookup_online", "clinic.unregistered"])).toEqual([]);
    expect(reads).toHaveLength(1);
  });
});
