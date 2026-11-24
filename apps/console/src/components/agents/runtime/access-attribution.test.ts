import { describe, expect, test } from "bun:test";
import { attributeGrants, attributeMcpConnections } from "./access-attribution.ts";

describe("grant attribution", () => {
  test("groups pinned tools by grant and marks grants missing from the list", () => {
    const attributed = attributeGrants(
      [
        {
          id: "dep-1",
          runtimeConfig: {
            toolAuthorizations: {
              "shopify.orders.search": { authorizationId: "grant-1", toolPolicyId: "policy-1" },
              "slack.post": { authorizationId: "grant-2" },
            },
          },
        },
        {
          id: "dep-2",
          runtimeConfig: {
            toolAuthorizations: { "shopify.orders.search": { authorizationId: "grant-1" } },
          },
        },
        { id: "dep-3" },
      ],
      [{ id: "grant-1" }, { id: "grant-unused" }],
    );
    expect(attributed).toEqual([
      {
        grant: { id: "grant-1" },
        grantId: "grant-1",
        uses: [
          { deploymentId: "dep-1", toolName: "shopify.orders.search", toolPolicyId: "policy-1" },
          { deploymentId: "dep-2", toolName: "shopify.orders.search", toolPolicyId: undefined },
        ],
      },
      {
        grant: undefined,
        grantId: "grant-2",
        uses: [{ deploymentId: "dep-1", toolName: "slack.post", toolPolicyId: undefined }],
      },
    ]);
  });
});

describe("MCP connection attribution", () => {
  const connections = [
    { id: "conn-granted", mcpServerId: "server-a" },
    { id: "conn-served", mcpServerId: "server-b" },
    { id: "conn-unrelated", mcpServerId: "server-c" },
  ];

  test("keeps connections reached through a pinned grant or a referenced MCP extension", () => {
    const attributed = attributeMcpConnections(
      connections,
      [
        { connectionId: "conn-granted", grantId: "grant-1" },
        { connectionId: undefined, grantId: "grant-missing" },
      ],
      [
        { execution: { mcpServerId: "server-b", type: "mcp" }, name: "docs.search" },
        { execution: { type: "http_callback" }, name: "crm.update" },
      ],
    );
    expect(attributed).toEqual([
      { connection: connections[0]!, extensionNames: [], grantIds: ["grant-1"] },
      { connection: connections[1]!, extensionNames: ["docs.search"], grantIds: [] },
    ]);
  });
});
