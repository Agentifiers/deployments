import { useSuspenseQuery } from "@tanstack/react-query";
import { agentEmailRoutesQuery } from "../../../data/agent-runtime-queries.ts";
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
import { Text, TextLink } from "@/components/ui/text";
import { Timestamp } from "../../observability/panels.tsx";
import { PublicId } from "../../public-id.tsx";
import { StatusBadge } from "@/components/status-badge";

/** Agent email inboxes with a `platform_agent` binding to one of the agent's deployments. */
export function EmailRoutes({
  agent,
  scope,
}: Readonly<{ agent: AgentDetail; scope: EnvironmentScope }>) {
  const { data: routes } = useSuspenseQuery(
    agentEmailRoutesQuery(
      scope,
      agent.definition.id,
      agent.deployments.map((deployment) => deployment.id),
    ),
  );
  if (routes.length === 0) {
    return (
      <Text>
        No inbox routes to this agent&apos;s deployments.{" "}
        <TextLink href={`${environmentPath(scope)}/email`}>Bind one from Email</TextLink>.
      </Text>
    );
  }
  return (
    <Table dense>
      <TableHeader>
        <TableRow>
          <TableHead>Inbox</TableHead>
          <TableHead>Inbox status</TableHead>
          <TableHead>Binding</TableHead>
          <TableHead>Binding status</TableHead>
          <TableHead>Deployment</TableHead>
          <TableHead>Bound</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {routes.flatMap(({ bindings, inbox }) =>
          bindings.map((binding) => (
            <TableRow key={binding.id}>
              <TableCell>
                <span className="flex flex-col">
                  <TextLink href={`${environmentPath(scope)}/email/inboxes/${inbox.id}`}>
                    {inbox.address}
                  </TextLink>
                  {inbox.name ? <span className="text-muted-foreground">{inbox.name}</span> : null}
                </span>
              </TableCell>
              <TableCell>
                <StatusBadge status={inbox.status} />
              </TableCell>
              <TableCell>
                <TextLink href={`${environmentPath(scope)}/email/bindings/${binding.id}`}>
                  <PublicId value={binding.id} />
                </TextLink>
              </TableCell>
              <TableCell>
                <StatusBadge status={binding.status} />
              </TableCell>
              <TableCell>
                {binding.agentDeploymentId ? <PublicId value={binding.agentDeploymentId} /> : "—"}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <Timestamp value={binding.createdAt} />
              </TableCell>
            </TableRow>
          )),
        )}
      </TableBody>
    </Table>
  );
}
