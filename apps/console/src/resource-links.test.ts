import { describe, expect, test } from "bun:test";
import { resourcePath } from "./resource-links.ts";
import { getRouter } from "./router.tsx";

const scope = { environmentId: "env1", organizationId: "org1", projectId: "prj1" };
const base = "/o/org1/p/prj1/e/env1";

describe("resourcePath", () => {
  test("names the route's full path and the link for each resource", () => {
    expect([
      resourcePath(scope, { connectionId: "con1", kind: "connection" }),
      resourcePath(scope, { kind: "webhook", webhookId: "whk1" }),
      resourcePath(scope, { kind: "oauthApps" }),
      resourcePath(scope, { kind: "mcpServer", mcpServerId: "mcp1" }),
      resourcePath(scope, { extensionId: "ext1", kind: "extension" }),
      resourcePath(scope, { kind: "toolPolicy", toolPolicyId: "pol1" }),
      resourcePath(scope, {
        kind: "newExtension",
        mcpServerId: "mcp1",
        remoteToolName: "search/web docs",
      }),
    ]).toEqual([
      {
        href: `${base}/connections/con1`,
        fullPath: "/o/$orgId/p/$projectId/e/$envId/connections/$connectionId",
      },
      {
        href: `${base}/webhooks/whk1`,
        fullPath: "/o/$orgId/p/$projectId/e/$envId/webhooks/$webhookId",
      },
      {
        href: `${base}/connections/oauth-apps`,
        fullPath: "/o/$orgId/p/$projectId/e/$envId/connections/oauth-apps",
      },
      {
        href: `${base}/mcp-servers/mcp1`,
        fullPath: "/o/$orgId/p/$projectId/e/$envId/mcp-servers/$serverId",
      },
      {
        href: `${base}/extensions/ext1`,
        fullPath: "/o/$orgId/p/$projectId/e/$envId/extensions/$extensionId",
      },
      {
        href: `${base}/tool-policies/pol1`,
        fullPath: "/o/$orgId/p/$projectId/e/$envId/tool-policies/$policyId",
      },
      {
        href: `${base}/extensions/new?remote=search%2Fweb+docs&server=mcp1&type=mcp`,
        fullPath: "/o/$orgId/p/$projectId/e/$envId/extensions/new",
      },
    ]);
  });

  test("names the wave 4 screens' full paths and links", () => {
    expect([
      resourcePath(scope, { definitionId: "wfd1", kind: "workflowDefinition" }),
      resourcePath(scope, { kind: "workflowRelease", releaseId: "wfr1" }),
      resourcePath(scope, { executionId: "wfe1", kind: "workflowExecution" }),
      resourcePath(scope, { brainId: "brn1", kind: "brain" }),
      resourcePath(scope, { kind: "memorySpace", memorySpaceId: "spc1" }),
    ]).toEqual([
      {
        href: `${base}/workflows/wfd1`,
        fullPath: "/o/$orgId/p/$projectId/e/$envId/workflows/$definitionId",
      },
      {
        href: `${base}/workflows/releases/wfr1`,
        fullPath: "/o/$orgId/p/$projectId/e/$envId/workflows/releases/$releaseId",
      },
      {
        href: `${base}/workflows/executions/wfe1`,
        fullPath: "/o/$orgId/p/$projectId/e/$envId/workflows/executions/$executionId",
      },
      {
        href: `${base}/brains/brn1`,
        fullPath: "/o/$orgId/p/$projectId/e/$envId/brains/$brainId",
      },
      {
        href: `${base}/memory/spaces/spc1`,
        fullPath: "/o/$orgId/p/$projectId/e/$envId/memory/spaces/$spaceId",
      },
    ]);
  });

  test("encodes identifiers into a single path segment", () => {
    expect(resourcePath(scope, { connectionId: "a/b", kind: "connection" }).href).toBe(
      `${base}/connections/a%2Fb`,
    );
  });

  test("full paths of screens on main are keys of the router's routes by path", () => {
    const { routesByPath } = getRouter();
    expect(
      [
        resourcePath(scope, { connectionId: "con1", kind: "connection" }),
        resourcePath(scope, { kind: "webhook", webhookId: "whk1" }),
        resourcePath(scope, { kind: "oauthApps" }),
        resourcePath(scope, { kind: "toolPolicy", toolPolicyId: "pol1" }),
        resourcePath(scope, { kind: "mcpServer", mcpServerId: "mcp1" }),
        resourcePath(scope, { definitionId: "wfd1", kind: "workflowDefinition" }),
        resourcePath(scope, { kind: "workflowRelease", releaseId: "wfr1" }),
        resourcePath(scope, { executionId: "wfe1", kind: "workflowExecution" }),
        resourcePath(scope, { brainId: "brn1", kind: "brain" }),
        resourcePath(scope, { kind: "memorySpace", memorySpaceId: "spc1" }),
      ].map(({ fullPath }) => Object.hasOwn(routesByPath, fullPath)),
    ).toEqual([true, true, true, true, true, true, true, true, true, true]);
  });
});
