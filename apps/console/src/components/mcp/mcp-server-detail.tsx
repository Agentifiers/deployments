import {
  Archive02Icon,
  Link01Icon,
  PencilEdit02Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ConsoleOperation, OperationAccess } from "../../access.ts";
import type { GrantRow } from "../../connections/connection-state.ts";
import { organizationShellQuery } from "../../data/console-queries.ts";
import {
  cappedDeploymentsQuery,
  cappedGrantsQuery,
  mcpServerQuery,
} from "../../data/mcp-queries.ts";
import { extensionDirectoryQuery, mcpDirectoryQuery } from "../../data/tool-directory-queries.ts";
import {
  canRevokeConnection,
  discoveryRows,
  endpointUrl,
  mcpGrantableScopes,
  pinning,
  serverActions,
  serverAuth,
  serverUsage,
  type GrantReads,
  type McpConnectionSummary,
  type McpDiscovery,
  type McpServerView,
  type ServerAction,
  type ServerAuth,
  type ServerUsage,
} from "../../mcp/mcp-state.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { CodeBlock } from "@/components/reui/code-block/code-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading, Subheading } from "@/components/ui/heading";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code, Text, TextLink } from "@/components/ui/text";
import { Icon } from "../icon.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { CreateGrantDialog, RevokeGrantDialog } from "../connections/grant-dialogs.tsx";
import { ResourceLink } from "../resource-link.tsx";
import {
  ArchiveMcpServerDialog,
  CreateMcpConnectionDialog,
  DiscoverMcpServerDialog,
  EditMcpServerDialog,
  RevokeMcpConnectionDialog,
} from "./mcp-server-dialogs.tsx";
import { StatusBadge } from "@/components/status-badge";

const ACTION_CONTROLS: Readonly<
  Record<
    ServerAction,
    { readonly icon: IconSvgElement; readonly label: string; readonly operation: ConsoleOperation }
  >
> = {
  archive: { icon: Archive02Icon, label: "Archive", operation: "archiveMcpServer" },
  connect: { icon: Link01Icon, label: "Add connection", operation: "createMcpConnection" },
  discover: { icon: Search01Icon, label: "Discover tools", operation: "discoverMcpServer" },
  edit: { icon: PencilEdit02Icon, label: "Edit", operation: "updateMcpServer" },
};

const AUTH_LABELS: Readonly<Record<ServerAuth, string>> = {
  deleted: "None. Archiving deleted the stored secret.",
  none: "None",
  stored: "A stored secret, which the platform never shows",
};

function DiscoveryResult({
  canCreateExtension,
  discovery,
  scope,
  server,
}: Readonly<{
  canCreateExtension: boolean;
  discovery: McpDiscovery;
  scope: EnvironmentScope;
  server: McpServerView;
}>) {
  const rows = discoveryRows(server.toolAllowlist, discovery);
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <Subheading>Discovered tools</Subheading>
        <Text>
          Checked <Timestamp value={discovery.verifiedAt} />. Nothing was saved.
        </Text>
      </div>
      <Table dense>
        <TableHeader>
          <TableRow>
            <TableHead>Tool</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>Input schema</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ remoteName, tool }) => (
            <TableRow key={remoteName}>
              <TableCell>
                <div className="flex flex-col items-start gap-1">
                  <Code>{remoteName}</Code>
                  {tool && canCreateExtension ? (
                    <ResourceLink
                      scope={scope}
                      to={{
                        kind: "newExtension",
                        mcpServerId: server.id,
                        remoteToolName: remoteName,
                      }}
                    >
                      Create extension
                    </ResourceLink>
                  ) : null}
                </div>
              </TableCell>
              {tool ? (
                <>
                  <TableCell className="max-w-96 whitespace-normal">
                    {tool.description ?? "None"}
                  </TableCell>
                  <TableCell>
                    <details>
                      <summary className="cursor-pointer text-sm/6">Show</summary>
                      <CodeBlock
                        className="mt-2 max-w-xl"
                        code={JSON.stringify(tool.inputSchema, null, 2)}
                        label={`${remoteName} input schema`}
                        language="json"
                        maxLines={12}
                      />
                    </details>
                  </TableCell>
                </>
              ) : (
                <TableCell colSpan={2}>
                  <Badge color="amber">not advertised</Badge> The server did not list this
                  allowlisted tool.
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

function ConnectionTable({
  access,
  agentByDeployment,
  onGrant,
  onRevoke,
  onRevokeGrant,
  scope,
  usage: { complete, connections, grantCoverage },
}: Readonly<{
  access: Pick<OperationAccess, "revokeConnectionGrant" | "revokeMcpConnection">;
  agentByDeployment: Readonly<Record<string, string>>;
  /** Absent when the caller cannot grant connections. */
  onGrant: ((connection: McpConnectionSummary) => void) | undefined;
  onRevoke: (connection: McpConnectionSummary) => void;
  onRevokeGrant: (row: GrantRow) => void;
  scope: EnvironmentScope;
  usage: ServerUsage;
}>) {
  const canRevoke = access.revokeMcpConnection;
  const hasActions = canRevoke || onGrant !== undefined;
  const grantsVisible = grantCoverage !== "unread";
  if (connections.length === 0) {
    return complete ? (
      <Text>
        No connections. A workspace grant points at a connection, so agents need one to call this
        server's tools. Create one, then grant it to a workspace.
      </Text>
    ) : (
      <Text>
        This environment has more MCP servers or connections than the console reads, and none of the
        connections it read belong to this server. This server may still have connections.
      </Text>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {complete ? null : (
        <Text>
          This environment has more MCP servers or connections than the console reads, so this
          server may have connections that are not listed.
        </Text>
      )}
      {grantCoverage === "partial" ? (
        <Text>
          This environment has more grants or deployments than the console reads, so some grants and
          the deployments pinning them may be missing.
        </Text>
      ) : null}
      <Table dense>
        <TableHeader>
          <TableRow>
            <TableHead>Connection</TableHead>
            <TableHead>Status</TableHead>
            {grantsVisible ? <TableHead>Grants and the deployments pinning them</TableHead> : null}
            {hasActions ? <TableHead /> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {connections.map(({ connection, grants }) => (
            <TableRow key={connection.id}>
              <TableCell>
                <PublicId value={connection.id} />
              </TableCell>
              <TableCell>
                <StatusBadge status={connection.status} />
              </TableCell>
              {grantsVisible ? (
                <TableCell className="whitespace-normal">
                  {grants.length === 0 ? (
                    "No grants"
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {grants.map(({ grant, uses }) => (
                        <li className="flex flex-wrap items-center gap-2" key={grant.id}>
                          <PublicId value={grant.id} />
                          <StatusBadge status={grant.status} />
                          {grant.workspaceId === null ? (
                            <span className="text-muted-foreground">all workspaces</span>
                          ) : (
                            <>
                              <span className="text-muted-foreground">workspace</span>
                              <PublicId value={grant.workspaceId} />
                            </>
                          )}
                          {uses.map((use) => {
                            const definitionId = agentByDeployment[use.deploymentId];
                            return (
                              <span
                                className="flex items-center gap-1"
                                key={`${use.deploymentId}:${use.toolName}`}
                              >
                                <PublicId value={use.deploymentId} />
                                {definitionId ? (
                                  <TextLink
                                    href={`${environmentPath(scope)}/agents/${definitionId}/tools`}
                                  >
                                    <Code>{use.toolName}</Code>
                                  </TextLink>
                                ) : (
                                  <Code>{use.toolName}</Code>
                                )}
                              </span>
                            );
                          })}
                          {access.revokeConnectionGrant && grant.status === "active" ? (
                            <Button
                              onClick={() => onRevokeGrant({ grant, uses })}
                              size="sm"
                              variant="ghost"
                            >
                              Revoke grant
                            </Button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </TableCell>
              ) : null}
              {hasActions ? (
                <TableCell className="text-right whitespace-nowrap">
                  {onGrant && connection.status === "active" ? (
                    <Button onClick={() => onGrant(connection)} variant="outline">
                      Grant to a workspace
                    </Button>
                  ) : null}
                  {canRevoke && canRevokeConnection(connection) ? (
                    <Button onClick={() => onRevoke(connection)} variant="ghost">
                      Revoke
                    </Button>
                  ) : null}
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

interface DetailProps {
  readonly access: OperationAccess;
  readonly scope: EnvironmentScope;
  readonly serverId: string;
}

export function McpServerDetail({
  scope,
  serverId,
}: Readonly<{ scope: EnvironmentScope; serverId: string }>) {
  const {
    data: { access },
  } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const props = { access, scope, serverId };
  return access.listConnectionGrants && access.listAgentDeployments ? (
    <DetailWithGrants {...props} />
  ) : (
    <Detail {...props} reads={undefined} />
  );
}

function DetailWithGrants(props: DetailProps) {
  const { data: grants } = useSuspenseQuery(cappedGrantsQuery(props.scope));
  const { data: deployments } = useSuspenseQuery(cappedDeploymentsQuery(props.scope));
  return <Detail {...props} reads={{ deployments, grants }} />;
}

function Detail({
  access,
  reads,
  scope,
  serverId,
}: DetailProps & { readonly reads: GrantReads | undefined }) {
  const { data: server } = useSuspenseQuery(mcpServerQuery(scope, serverId));
  const { data: directory } = useSuspenseQuery(mcpDirectoryQuery(scope));
  const usage = serverUsage(serverId, directory, reads);
  const agentByDeployment = Object.fromEntries(
    (reads?.deployments.items ?? []).map(({ agentDefinitionId, id }) => [id, agentDefinitionId]),
  );
  const [dialog, setDialog] = useState<ServerAction>();
  const [revoking, setRevoking] = useState<McpConnectionSummary>();
  const [granting, setGranting] = useState<McpConnectionSummary>();
  const [revokingGrant, setRevokingGrant] = useState<GrantRow>();
  // Grants need the extension list for their scopes, and the grant list to show the result.
  const canGrant = access.createConnectionGrant && access.listExtensionTools && reads !== undefined;
  const [discovery, setDiscovery] = useState<{
    readonly result: McpDiscovery;
    readonly version: number;
  }>();
  const actions = serverActions(server).filter(
    (action) => access[ACTION_CONTROLS[action].operation],
  );
  const close = () => setDialog(undefined);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading level={2}>{server.name}</Heading>
        <StatusBadge status={server.status} />
        <div className="ml-auto flex flex-wrap gap-3">
          {actions.map((action) => {
            const { icon, label } = ACTION_CONTROLS[action];
            return (
              <Button
                key={action}
                onClick={() => setDialog(action)}
                variant={action === "archive" ? "destructive" : "outline"}
              >
                <Icon icon={icon} />
                {label}
              </Button>
            );
          })}
        </div>
      </div>
      <DescriptionList>
        <DescriptionTerm>ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={server.id} />
        </DescriptionDetails>
        <DescriptionTerm>Endpoint</DescriptionTerm>
        <DescriptionDetails>
          <Code>{endpointUrl(server)}</Code>
        </DescriptionDetails>
        <DescriptionTerm>Authentication</DescriptionTerm>
        <DescriptionDetails>{AUTH_LABELS[serverAuth(server)]}</DescriptionDetails>
        <DescriptionTerm>Tool allowlist</DescriptionTerm>
        <DescriptionDetails>
          <ul className="flex flex-wrap gap-2">
            {server.toolAllowlist.map((name) => (
              <li key={name}>
                <Code>{name}</Code>
              </li>
            ))}
          </ul>
        </DescriptionDetails>
        <DescriptionTerm>Version</DescriptionTerm>
        <DescriptionDetails>{server.version}</DescriptionDetails>
        <DescriptionTerm>Created</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={server.createdAt} />
        </DescriptionDetails>
        <DescriptionTerm>Updated</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={server.updatedAt} />
        </DescriptionDetails>
      </DescriptionList>
      {discovery?.version === server.version ? (
        <DiscoveryResult
          canCreateExtension={access.createExtensionTool}
          discovery={discovery.result}
          scope={scope}
          server={server}
        />
      ) : null}
      <section className="flex flex-col gap-4">
        <Subheading>Connections</Subheading>
        {usage.grantCoverage === "unread" ? (
          <Text>
            Your role or token scopes do not permit listing grants (providers:read) or agent
            deployments (agents:read), so grants are not shown.
          </Text>
        ) : null}
        <ConnectionTable
          access={access}
          agentByDeployment={agentByDeployment}
          onGrant={canGrant ? setGranting : undefined}
          onRevoke={setRevoking}
          onRevokeGrant={setRevokingGrant}
          scope={scope}
          usage={usage}
        />
      </section>
      {access.updateMcpServer ? (
        <EditMcpServerDialog
          onClose={close}
          open={dialog === "edit"}
          scope={scope}
          server={server}
        />
      ) : null}
      {access.discoverMcpServer ? (
        <DiscoverMcpServerDialog
          onClose={close}
          onResult={(result) => setDiscovery({ result, version: server.version })}
          open={dialog === "discover"}
          scope={scope}
          server={server}
        />
      ) : null}
      {access.createMcpConnection ? (
        <CreateMcpConnectionDialog
          onClose={close}
          open={dialog === "connect"}
          scope={scope}
          server={server}
        />
      ) : null}
      {access.archiveMcpServer ? (
        <ArchiveMcpServerDialog
          onClose={close}
          open={dialog === "archive"}
          pinning={pinning(usage)}
          scope={scope}
          server={server}
        />
      ) : null}
      {canGrant && granting ? (
        <GrantMcpConnectionDialog
          connection={granting}
          onClose={() => setGranting(undefined)}
          scope={scope}
          server={server}
        />
      ) : null}
      {access.revokeConnectionGrant && revokingGrant ? (
        <RevokeGrantDialog
          onClose={() => setRevokingGrant(undefined)}
          row={revokingGrant}
          scope={scope}
        />
      ) : null}
      {access.revokeMcpConnection && revoking ? (
        <RevokeMcpConnectionDialog
          connection={revoking}
          onClose={() => setRevoking(undefined)}
          open
          pinning={pinning(usage, revoking.id)}
          scope={scope}
        />
      ) : null}
    </div>
  );
}

function GrantMcpConnectionDialog({
  connection,
  onClose,
  scope,
  server,
}: Readonly<{
  connection: McpConnectionSummary;
  onClose: () => void;
  scope: EnvironmentScope;
  server: McpServerView;
}>) {
  const { data: extensions } = useSuspenseQuery(extensionDirectoryQuery(scope));
  return (
    <CreateGrantDialog
      connection={{ displayName: server.name, id: connection.id }}
      grantableScopes={mcpGrantableScopes(server.id, extensions.extensions)}
      onClose={onClose}
      open
      scope={scope}
    />
  );
}
