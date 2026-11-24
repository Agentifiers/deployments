import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  connectionGrantsQuery,
  toolEvaluationsQuery,
} from "../../../data/agent-runtime-queries.ts";
import {
  extensionDirectoryQuery,
  mcpDirectoryQuery,
} from "../../../data/tool-directory-queries.ts";
import { environmentPath, type EnvironmentScope } from "../../../scope.ts";
import type { AgentDetail } from "../../../server/agent-data.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code, Text, TextLink } from "@/components/ui/text";
import { Timestamp } from "../../observability/panels.tsx";
import { PublicId } from "../../public-id.tsx";
import { liveDeployments } from "../agent-header.tsx";
import {
  attributeGrants,
  attributeMcpConnections,
  referencedExtensions,
} from "./access-attribution.ts";
import { StatusBadge } from "@/components/status-badge";

function NoneFound({ children }: Readonly<{ children: string }>) {
  return <Text>{children}</Text>;
}

/** Tool names the live deployments' evaluations returned, shared with the effective-tools block. */
function useEvaluatedToolNames(agent: AgentDetail, scope: EnvironmentScope) {
  const live = liveDeployments(agent);
  const { data: evaluations } = useSuspenseQuery(
    toolEvaluationsQuery(
      scope,
      agent.definition.id,
      live.map((deployment) => deployment.id),
    ),
  );
  return useMemo(
    () =>
      new Set(
        evaluations.flatMap((evaluation) =>
          "results" in evaluation ? evaluation.results.map((result) => result.toolName) : [],
        ),
      ),
    [evaluations],
  );
}

/**
 * Connection grants the live deployments pin in `runtimeConfig.toolAuthorizations`. Grants have
 * no agent field; this pin is the only link between a grant and an agent.
 */
export function ConnectionGrants({
  agent,
  scope,
}: Readonly<{ agent: AgentDetail; scope: EnvironmentScope }>) {
  const { data: grants } = useSuspenseQuery(connectionGrantsQuery(scope));
  const attributed = attributeGrants(liveDeployments(agent), grants);
  if (attributed.length === 0) {
    return (
      <NoneFound>No live deployment pins a connection grant in its tool authorizations.</NoneFound>
    );
  }
  return (
    <Table dense>
      <TableHeader>
        <TableRow>
          <TableHead>Grant</TableHead>
          <TableHead>Provider</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Purpose</TableHead>
          <TableHead>Scopes</TableHead>
          <TableHead>Pinned by</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {attributed.map(({ grant, grantId, uses }) => (
          <TableRow key={grantId}>
            <TableCell>
              <PublicId value={grantId} />
            </TableCell>
            {grant ? (
              <>
                <TableCell>
                  <TextLink href={`${environmentPath(scope)}/connections/${grant.connectionId}`}>
                    {grant.providerKey}
                  </TextLink>
                </TableCell>
                <TableCell>
                  <StatusBadge status={grant.status} />
                </TableCell>
                <TableCell>{grant.purpose}</TableCell>
                <TableCell className="max-w-72 whitespace-normal">
                  {grant.scopes.length === 0 ? "—" : grant.scopes.join(", ")}
                </TableCell>
              </>
            ) : (
              <TableCell className="text-muted-foreground" colSpan={4}>
                Not in this environment's grants; the runtime denies these tools.
              </TableCell>
            )}
            <TableCell>
              <ul className="flex flex-col gap-1">
                {uses.map((use) => (
                  <li
                    className="flex items-center gap-2"
                    key={`${use.deploymentId}:${use.toolName}`}
                  >
                    <PublicId value={use.deploymentId} />
                    <Code>{use.toolName}</Code>
                  </li>
                ))}
              </ul>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * MCP connections the agent reaches: through a pinned grant on the connection, or through an MCP
 * extension one of its tools names. Sources the caller may not read are left out and said so.
 */
export function McpConnections({
  agent,
  canReadExtensions,
  canReadGrants,
  scope,
}: Readonly<{
  agent: AgentDetail;
  canReadExtensions: boolean;
  canReadGrants: boolean;
  scope: EnvironmentScope;
}>) {
  const { data: directory } = useSuspenseQuery(mcpDirectoryQuery(scope));
  const toolNames = useEvaluatedToolNames(agent, scope);
  const grants = useQuery({ ...connectionGrantsQuery(scope), enabled: canReadGrants });
  const extensions = useQuery({ ...extensionDirectoryQuery(scope), enabled: canReadExtensions });
  if ((canReadGrants && grants.isPending) || (canReadExtensions && extensions.isPending)) {
    return <Text>Loading grants and extensions…</Text>;
  }
  const pinned = attributeGrants(liveDeployments(agent), grants.data ?? []).map((entry) => ({
    connectionId: entry.grant?.providerKey === "mcp" ? entry.grant.connectionId : undefined,
    grantId: entry.grantId,
  }));
  const attributed = attributeMcpConnections(
    directory.connections,
    pinned,
    referencedExtensions(toolNames, extensions.data?.extensions ?? []),
  );
  const unreadable = [
    ...(canReadGrants ? [] : ["connection grants"]),
    ...(canReadExtensions ? [] : ["extensions"]),
  ];
  return (
    <div className="flex flex-col gap-3">
      {unreadable.length > 0 ? (
        <Text>
          Your access does not include {unreadable.join(" or ")}, so connections reached through
          them are not shown.
        </Text>
      ) : null}
      {directory.complete && extensions.data?.complete !== false ? null : (
        <Text>
          This environment has more MCP connections, servers, or extensions than the console reads,
          so the list covers the first 2,000 of each.
        </Text>
      )}
      {attributed.length === 0 ? (
        <NoneFound>No MCP connection serves this agent's tools.</NoneFound>
      ) : (
        <Table dense>
          <TableHeader>
            <TableRow>
              <TableHead>Connection</TableHead>
              <TableHead>MCP server</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Reached through</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {attributed.map(({ connection, extensionNames, grantIds }) => {
              const server = directory.servers.find(({ id }) => id === connection.mcpServerId);
              return (
                <TableRow key={connection.id}>
                  <TableCell>
                    <PublicId value={connection.id} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {server ? <span className="mr-2">{server.name}</span> : null}
                    <PublicId value={connection.mcpServerId} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={connection.status} />
                  </TableCell>
                  <TableCell>
                    <ul className="flex flex-col gap-1">
                      {grantIds.map((grantId) => (
                        <li className="flex items-center gap-2" key={grantId}>
                          Grant <PublicId value={grantId} />
                        </li>
                      ))}
                      {extensionNames.map((name) => (
                        <li key={name}>
                          Extension <Code>{name}</Code>
                        </li>
                      ))}
                    </ul>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <Timestamp value={connection.updatedAt} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/** Tenant extensions (MCP, HTTP callback, client, hosted code) named by the agent's tools. */
export function ReferencedExtensions({
  agent,
  scope,
}: Readonly<{ agent: AgentDetail; scope: EnvironmentScope }>) {
  const { data: directory } = useSuspenseQuery(extensionDirectoryQuery(scope));
  const toolNames = useEvaluatedToolNames(agent, scope);
  const referenced = referencedExtensions(toolNames, directory.extensions);
  return (
    <div className="flex flex-col gap-3">
      {directory.complete ? null : (
        <Text>
          This environment has more extensions than the console reads, so the list covers the first
          2,000.
        </Text>
      )}
      {referenced.length === 0 ? (
        <NoneFound>None of the live deployments' tools is an extension.</NoneFound>
      ) : (
        <Table dense>
          <TableHeader>
            <TableRow>
              <TableHead>Tool</TableHead>
              <TableHead>Execution</TableHead>
              <TableHead>Effect</TableHead>
              <TableHead>Default</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Version</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {referenced.map((extension) => (
              <TableRow key={extension.id}>
                <TableCell>
                  <Code>{extension.name}</Code>
                </TableCell>
                <TableCell>{extension.execution.type}</TableCell>
                <TableCell>{extension.effect}</TableCell>
                <TableCell>
                  <StatusBadge status={extension.defaultPolicyAction} />
                </TableCell>
                <TableCell>{extension.providerKey ?? "—"}</TableCell>
                <TableCell>
                  <StatusBadge status={extension.status} />
                </TableCell>
                <TableCell className="tabular-nums">{extension.version}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
