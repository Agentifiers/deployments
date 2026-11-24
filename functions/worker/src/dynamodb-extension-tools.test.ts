import { expect, test } from "bun:test";
import {
  makeUniqueClaimRecord,
  ToolAdapterRecord,
  uniqueClaimRequirements,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { createDynamoExtensionToolResolver } from "./dynamodb-extension-tools.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;
const MCP_SERVER_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid;

function adapter(id: Ulid, status: "active" | "archived") {
  return Schema.decodeUnknownSync(ToolAdapterRecord)(
    withCanonicalRecordKeys({
      itemType: "tool-adapter",
      data: {
        createdAt: "2026-07-26T12:00:00.000Z",
        defaultPolicyAction: "deny",
        description: `${status} adapter`,
        effect: "read",
        environmentId: ENVIRONMENT_ID,
        execution: {
          mcpServerId: MCP_SERVER_ID,
          remoteToolName: "remote.read",
          type: "mcp",
        },
        id,
        inputSchema: { type: "object" },
        name: "custom.reused",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        requiredScopes: [],
        status,
        updatedAt: "2026-07-26T12:00:00.000Z",
        version: status === "active" ? 0 : 1,
      },
    }),
  );
}

test("resolves a fresh extension through strongly consistent unique-claim reads", async () => {
  const replacement = adapter("01ARZ3NDEKTSV4RRFFQ69G5FB0" as Ulid, "active");
  const requirement = uniqueClaimRequirements(replacement)[0]!;
  const claim = makeUniqueClaimRecord(requirement, replacement.data.createdAt);
  const consistentReads: boolean[] = [];
  const database = {
    getRecord: async (
      _table: string,
      key: { readonly pk: string; readonly sk: string },
      consistent?: boolean,
    ) => {
      consistentReads.push(consistent === true);
      return key.pk === claim.pk && key.sk === claim.sk ? claim : replacement;
    },
    queryRecords: () => {
      throw new Error("extension resolution must not depend on an eventual index");
    },
  } as unknown as DynamoDatabaseService;

  expect(
    createDynamoExtensionToolResolver(database)("custom.reused", {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    }),
  ).resolves.toMatchObject({
    description: "active adapter",
    toolName: "custom.reused",
  });
  expect(consistentReads).toEqual([true, true]);
});
