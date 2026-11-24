import { describe, expect, test } from "bun:test";
import type { BrainSource } from "@deployments-ai/brains";
import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import type { PlatformRecord } from "../records/index.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { ProviderConnectionRecord } from "../records/provider-connections.ts";
import { githubConnectionAuthorization } from "./connector-authorization.ts";

const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const brainId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const sourceId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const principalId = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const connectionId = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const projectId = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const environmentId = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
const credentialId = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
const now = "2026-07-31T12:00:00.000Z";

const source: BrainSource = {
  brainId,
  configuration: { owner: "deployments-ai", repository: "platform" },
  connectionId,
  createdAt: now,
  createdByPrincipalId: principalId,
  environmentId,
  id: sourceId,
  kind: "github",
  name: "GitHub",
  organizationId,
  projectId,
  status: "active",
  updatedAt: now,
  updatedByPrincipalId: principalId,
  version: 0,
};

/** Connection as persisted by the vendor_mcp OAuth callback for provider `github`. */
function vendorMcpGitHubConnection(overrides: {
  readonly authMethod?: string;
  readonly scopes?: readonly string[];
}) {
  return Schema.decodeUnknownSync(ProviderConnectionRecord)(
    withCanonicalRecordKeys({
      data: {
        authMethod: overrides.authMethod ?? "oauth",
        authorizationScopes: ["repo", "read:org", "read:user"],
        credentialRef: { credentialId, generation: 3, store: "dynamodb-kms" },
        createdAt: now,
        environmentId,
        id: connectionId,
        oauthIssuer: "https://github.com/login/oauth",
        oauthResource: "https://api.githubcopilot.com/mcp/",
        organizationId,
        projectId,
        providerKey: "github",
        scopes: overrides.scopes ?? ["tools:read", "tools:write"],
        status: "active",
        updatedAt: now,
        version: 4,
      },
      itemType: "provider-connection" as const,
    }),
  );
}

function databaseWith(connection: PlatformRecord): DynamoDatabaseService {
  return {
    deleteRecord: async () => {},
    getRecord: async (_table, key) =>
      key.pk === connection.pk && key.sk === connection.sk ? connection : undefined,
    putRecord: async () => {},
    queryRecords: async () => ({ items: [] }),
    transactWrite: async () => {},
  };
}

describe("GitHub Brain connection authorization", () => {
  test("authorizes a github vendor_mcp connection granting tools:read and pins its version", async () => {
    const connection = vendorMcpGitHubConnection({ scopes: ["tools:read"] });

    const authorization = await githubConnectionAuthorization(databaseWith(connection), source);

    expect(authorization.connection).toBe(connection);
    expect(authorization.condition).toMatchObject({
      key: { pk: connection.pk, sk: connection.sk },
      kind: "condition-check",
      table: "control",
    });
    expect(
      authorization.condition.kind === "condition-check"
        ? authorization.condition.expressionAttributeValues
        : undefined,
    ).toMatchObject({ ":github": "github", ":version": 4 });
  });

  test.each([
    ["lacks tools:read even with GitHub-native repo scopes", { scopes: ["tools:write"] }],
    ["is not an OAuth connection", { authMethod: "api_key" }],
  ])("rejects a github connection that %s", async (_case, overrides) => {
    const connection = vendorMcpGitHubConnection(overrides);

    expect(githubConnectionAuthorization(databaseWith(connection), source)).rejects.toThrow(
      "GitHub Brain sources require an active GitHub connection granting tools:read.",
    );
  });
});
