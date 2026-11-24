import { PublicId } from "@deployments-ai/api-contract/primitives";
import { ConnectionGrantResponse } from "@deployments-ai/api-contract/providers";
import { WorkspaceResponse } from "@deployments-ai/api-contract/tenancy";
import { McpServerResponse } from "@deployments-ai/api-contract/tooling";
import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { Schema } from "effect";
import { act } from "react";
import type { OperationAccess } from "../../access.ts";
import * as connectionMutations from "../../data/connection-mutations.ts";
import { workspacesQuery } from "../../data/connection-queries.ts";
import { organizationShellQuery } from "../../data/console-queries.ts";
import {
  cappedDeploymentsQuery,
  cappedGrantsQuery,
  mcpServerQuery,
} from "../../data/mcp-queries.ts";
import { extensionDirectoryQuery, mcpDirectoryQuery } from "../../data/tool-directory-queries.ts";
import type { GrantView } from "../../connections/connection-state.ts";
import type { ExtensionDirectory, McpDirectory } from "../../server/tool-directory.ts";
import type { ClientView } from "@/components/ui/render-client";
import { accessOf, renderWith, scope } from "../apps/app-fixtures.tsx";
import { McpServerDetail } from "./mcp-server-detail.tsx";

const id = Schema.decodeUnknownSync(PublicId);
const SERVER = id("01K00000000000000000000MS1");
const CONNECTION = id("01K00000000000000000000MC1");
const GRANT = id("01K00000000000000000000GR1");
const WORKSPACE = id("01K00000000000000000000WS1");
const AT = "2026-10-09T12:00:00.000Z";

const created: Readonly<Record<string, unknown>>[] = [];
const revoked: Readonly<Record<string, unknown>>[] = [];
spyOn(connectionMutations, "createGrantFn").mockImplementation((async ({
  data,
}: {
  readonly data: Readonly<Record<string, unknown>>;
}) => {
  created.push(data);
  return grant("active");
}) as unknown as typeof connectionMutations.createGrantFn);
spyOn(connectionMutations, "revokeGrantFn").mockImplementation((async ({
  data,
}: {
  readonly data: Readonly<Record<string, unknown>>;
}) => {
  revoked.push(data);
  return grant("revoked");
}) as unknown as typeof connectionMutations.revokeGrantFn);
afterAll(() => {
  mock.restore();
});

function grant(status: "active" | "revoked"): GrantView {
  return Schema.decodeUnknownSync(ConnectionGrantResponse)({
    authorizationVersion: 1,
    connectionId: CONNECTION,
    createdAt: AT,
    externalAccountId: SERVER,
    externalResourceConstraints: {},
    id: GRANT,
    providerKey: "mcp",
    purpose: "agent-runtime",
    scopes: ["docs:read"],
    status,
    updatedAt: AT,
    version: 1,
    workspaceId: WORKSPACE,
  });
}

const directory: McpDirectory = {
  complete: true,
  connections: [
    { id: CONNECTION, mcpServerId: SERVER, status: "active", updatedAt: AT, version: 1 },
  ],
  servers: [],
};

const extensions: ExtensionDirectory = {
  complete: true,
  extensions: [
    {
      defaultPolicyAction: "allow",
      effect: "read",
      execution: { mcpServerId: SERVER, remoteToolName: "search", type: "mcp" },
      id: id("01K00000000000000000000EX1"),
      name: "docs.search",
      requiredScopes: ["docs:read"],
      status: "active",
      version: 1,
    },
    {
      defaultPolicyAction: "allow",
      effect: "write",
      execution: { mcpServerId: SERVER, remoteToolName: "edit", type: "mcp" },
      id: id("01K00000000000000000000EX2"),
      name: "docs.edit",
      requiredScopes: ["docs:write"],
      status: "archived",
      version: 1,
    },
  ],
};

function client(grants: readonly GrantView[], access: OperationAccess) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(organizationShellQuery(scope.organizationId).queryKey, {
    access,
  } as never);
  queryClient.setQueryData(
    ["environment", scope.organizationId, scope.projectId, scope.environmentId],
    { type: "development" },
  );
  queryClient.setQueryData(
    mcpServerQuery(scope, SERVER).queryKey,
    Schema.decodeUnknownSync(McpServerResponse)({
      createdAt: AT,
      endpointOrigin: "https://mcp.example.com",
      endpointPath: "/mcp",
      hasAuth: false,
      id: SERVER,
      name: "Docs",
      status: "active",
      toolAllowlist: ["search", "edit"],
      updatedAt: AT,
      version: 1,
    }),
  );
  queryClient.setQueryData(mcpDirectoryQuery(scope).queryKey, directory);
  queryClient.setQueryData(extensionDirectoryQuery(scope).queryKey, extensions);
  queryClient.setQueryData(cappedGrantsQuery(scope).queryKey, { complete: true, items: grants });
  queryClient.setQueryData(cappedDeploymentsQuery(scope).queryKey, { complete: true, items: [] });
  queryClient.setQueryData(workspacesQuery(scope).queryKey, [
    Schema.decodeUnknownSync(WorkspaceResponse)({
      createdAt: AT,
      environmentId: scope.environmentId,
      id: WORKSPACE,
      name: "Support",
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      slug: "support",
      status: "active",
      updatedAt: AT,
      version: 1,
    }),
  ]);
  return queryClient;
}

async function page(grants: readonly GrantView[], access: OperationAccess) {
  const queryClient = client(grants, access);
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <McpServerDetail scope={scope} serverId={SERVER} />,
    }),
  });
  await router.load();
  return { queryClient, ui: <RouterProvider router={router} /> };
}

const button = (root: ParentNode | null | undefined, text: string) =>
  [...(root?.querySelectorAll("button") ?? [])].find((node) => node.textContent?.trim() === text);

/** Sets a controlled field's value and calls its React onChange with a change event. */
async function change(
  field: HTMLInputElement | HTMLSelectElement | null | undefined,
  value: string,
) {
  if (!field) throw new Error("no field");
  const props = Object.entries(field).find(([key]) => key.startsWith("__reactProps$"))?.[1] as {
    onChange: (event: unknown) => void;
  };
  await act(async () => {
    field.value = value;
    props.onChange({ currentTarget: field, nativeEvent: new Event("change"), target: field });
  });
}

const dialogOf = (view: ClientView) => view.document.querySelector('[role="dialog"]');

describe("MCP connection grants", () => {
  test("an admin grants an MCP connection to a workspace with the server's active tool scopes", async () => {
    created.length = 0;
    const { queryClient, ui } = await page([], accessOf("admin"));
    let dialogText: string | undefined;
    let scopes: (string | null | undefined)[] = [];
    await renderWith(queryClient, ui, async (view) => {
      expect(view.document.body.textContent).not.toContain("deployments grant create");
      await view.click(button(view.document, "Grant to a workspace"));
      const dialog = dialogOf(view);
      dialogText = dialog?.querySelector("h2")?.textContent ?? undefined;
      scopes = [...(dialog?.querySelectorAll("label.font-mono") ?? [])].map(
        (label) => label.textContent,
      );
      await change(dialog?.querySelector("select"), WORKSPACE);
      await view.click(dialog?.querySelector('[role="checkbox"]'));
      await view.click(button(dialog, "Grant"));
    });
    expect(dialogText).toBe("Grant Docs to a workspace");
    expect(scopes).toEqual(["docs:read"]);
    expect(created).toEqual([
      {
        body: {
          connectionId: CONNECTION,
          purpose: "agent-runtime",
          scopes: ["docs:read"],
          workspaceId: WORKSPACE,
        },
        idempotencyKey: expect.any(String),
        scope,
      },
    ]);
  });

  test("an admin revokes an active MCP grant; a member sees neither action", async () => {
    revoked.length = 0;
    const admin = await page([grant("active")], accessOf("admin"));
    await renderWith(admin.queryClient, admin.ui, async (view) => {
      await view.click(button(view.document, "Revoke grant"));
      const dialog = dialogOf(view);
      await change(
        dialog?.querySelector<HTMLInputElement>('input[name="confirmation"]'),
        GRANT.slice(-8),
      );
      await view.click(button(dialog, "Revoke grant"));
    });
    expect(revoked).toEqual([
      {
        body: { expectedVersion: 1 },
        grantId: GRANT,
        idempotencyKey: expect.any(String),
        scope,
      },
    ]);

    const member = await page([grant("active")], accessOf("member"));
    await renderWith(member.queryClient, member.ui, async (view) => {
      expect(view.document.querySelector("tbody tr")?.textContent).toContain("workspace");
      expect(button(view.document, "Grant to a workspace")).toBeUndefined();
      expect(button(view.document, "Revoke grant")).toBeUndefined();
    });
  });
});
