import { ApiIcon, BubbleChatIcon, RocketIcon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import { isRepinnable } from "../../connections/rebind.ts";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import type { AgentDeployment, AgentDetail } from "../../server/agent-data.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Subheading } from "@/components/ui/heading";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code, Text } from "@/components/ui/text";
import { Icon } from "../icon.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { CanaryBar, releaseLabel } from "./agent-header.tsx";
import { DeploymentActions, DeployReleaseAction } from "./deployment-actions.tsx";
import { StatusBadge } from "@/components/status-badge";

type RuntimeConfig = NonNullable<AgentDeployment["runtimeConfig"]>;

/** Runtime config fields with their own tables; the rest render as plain values. */
const TABLED_FIELDS = new Set(["agentBindings", "apiVersion", "kind", "toolAuthorizations"]);

function plainValue(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The deployment's runtime configuration; tool bindings are edited on their own page. */
function RuntimeConfigView({ config }: Readonly<{ config: RuntimeConfig | undefined }>) {
  if (!config) return <Text>No runtime configuration.</Text>;
  const tools = Object.entries(config.toolAuthorizations ?? {});
  const bindings = Object.entries(config.agentBindings ?? {});
  const other = Object.entries(config).filter(([field]) => !TABLED_FIELDS.has(field));
  return (
    <div className="flex flex-col gap-4">
      {other.length > 0 ? (
        <DescriptionList>
          {other.map(([field, value]) => (
            <Fragment key={field}>
              <DescriptionTerm>{field}</DescriptionTerm>
              <DescriptionDetails>
                <Code>{plainValue(value)}</Code>
              </DescriptionDetails>
            </Fragment>
          ))}
        </DescriptionList>
      ) : null}
      <div className="flex flex-col gap-2">
        <span className="text-sm/6 font-medium">Tool authorizations</span>
        {tools.length === 0 ? (
          <Text>None.</Text>
        ) : (
          <Table dense>
            <TableHeader>
              <TableRow>
                <TableHead>Tool</TableHead>
                <TableHead>Authorization</TableHead>
                <TableHead>Tool policy</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tools.map(([tool, binding]) => (
                <TableRow key={tool}>
                  <TableCell>
                    <Code>{tool}</Code>
                  </TableCell>
                  <TableCell>
                    <PublicId value={binding.authorizationId} />
                  </TableCell>
                  <TableCell>
                    {binding.toolPolicyId ? <PublicId value={binding.toolPolicyId} /> : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm/6 font-medium">Sub-agent bindings</span>
        {bindings.length === 0 ? (
          <Text>None.</Text>
        ) : (
          <Table dense>
            <TableHeader>
              <TableRow>
                <TableHead>Manifest key</TableHead>
                <TableHead>Deployment</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bindings.map(([key, binding]) => (
                <TableRow key={key}>
                  <TableCell>
                    <Code>{key}</Code>
                  </TableCell>
                  <TableCell>
                    <PublicId value={binding.agentDeploymentId} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

function DeploymentCard({
  agent,
  deployment,
}: Readonly<{ agent: AgentDetail; deployment: AgentDeployment }>) {
  const { definition } = agent;
  const scope: EnvironmentScope = {
    environmentId: definition.environmentId,
    organizationId: definition.organizationId,
    projectId: definition.projectId,
  };
  const { access } = useSuspenseQuery(organizationShellQuery(scope.organizationId)).data;
  const candidate = deployment.candidateAgentReleaseId;
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Deployment <PublicId value={deployment.id} />
          <StatusBadge status={deployment.currentState} />
          {candidate ? <Badge color="amber">canary</Badge> : null}
        </CardTitle>
        <CardAction className="flex flex-wrap items-center gap-3">
          {access.createThread && access.submitAgentRun && access.listRuns ? (
            <Button
              href={`${environmentPath(scope)}/agents/${definition.id}/chat/${deployment.id}`}
              variant="outline"
            >
              <Icon icon={BubbleChatIcon} />
              Chat
            </Button>
          ) : null}
          {deployment.currentState === "ready" ? (
            <Button
              href={`${environmentPath(scope)}/integrate?deployment=${deployment.id}`}
              variant="outline"
            >
              <Icon icon={ApiIcon} />
              Integrate
            </Button>
          ) : null}
          <DeploymentActions agent={agent} deployment={deployment} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <DescriptionList>
          <DescriptionTerm>Current state</DescriptionTerm>
          <DescriptionDetails>{deployment.currentState}</DescriptionDetails>
          <DescriptionTerm>Desired state</DescriptionTerm>
          <DescriptionDetails>{deployment.desiredState}</DescriptionDetails>
          <DescriptionTerm>Pinned release</DescriptionTerm>
          <DescriptionDetails className="flex items-center gap-2">
            {releaseLabel(agent, deployment.agentReleaseId)}
            <PublicId value={deployment.agentReleaseId} />
          </DescriptionDetails>
          <DescriptionTerm>Canary</DescriptionTerm>
          <DescriptionDetails>
            {candidate && deployment.candidateWeight !== undefined ? (
              <div className="flex flex-col gap-2">
                <span className="flex flex-wrap items-center gap-2">
                  Candidate {releaseLabel(agent, candidate)} · {deployment.candidateWeight}% of new
                  threads
                  {deployment.candidateStartedAt ? (
                    <>
                      {" "}
                      · started <Timestamp value={deployment.candidateStartedAt} />
                    </>
                  ) : null}
                </span>
                <CanaryBar
                  candidate={releaseLabel(agent, candidate)}
                  primary={releaseLabel(agent, deployment.agentReleaseId)}
                  weight={deployment.candidateWeight}
                />
              </div>
            ) : (
              "None"
            )}
          </DescriptionDetails>
          <DescriptionTerm>Last transition</DescriptionTerm>
          <DescriptionDetails>
            {deployment.lastTransitionAt ? <Timestamp value={deployment.lastTransitionAt} /> : "—"}
          </DescriptionDetails>
          <DescriptionTerm>Revision</DescriptionTerm>
          <DescriptionDetails className="tabular-nums">{deployment.version}</DescriptionDetails>
          <DescriptionTerm>Created</DescriptionTerm>
          <DescriptionDetails>
            <Timestamp value={deployment.createdAt} />
          </DescriptionDetails>
        </DescriptionList>
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Subheading level={3}>Runtime configuration</Subheading>
            {access.updateAgentDeployment && isRepinnable(deployment) ? (
              <Button
                className="ml-auto"
                href={`${environmentPath(scope)}/agents/${definition.id}/bindings/${deployment.id}`}
                variant="outline"
              >
                Edit tool bindings
              </Button>
            ) : null}
          </div>
          <RuntimeConfigView config={deployment.runtimeConfig} />
        </section>
      </CardContent>
    </Card>
  );
}

/**
 * Deployments tab (plan §6.1): every live deployment with its state, releases, canary, runtime
 * configuration, and actions, then the stopped ones, which no action can change.
 */
export function DeploymentList({ agent }: Readonly<{ agent: AgentDetail }>) {
  const live = agent.deployments.filter((deployment) => deployment.currentState !== "stopped");
  const stopped = agent.deployments.filter((deployment) => deployment.currentState === "stopped");
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Subheading>
          {live.length} live {live.length === 1 ? "deployment" : "deployments"}
        </Subheading>
        <div className="ml-auto">
          <DeployReleaseAction agent={agent} />
        </div>
      </div>
      {live.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Icon icon={RocketIcon} />
            </EmptyMedia>
            <EmptyTitle>No live deployment</EmptyTitle>
            <EmptyDescription>Deploy an active release to serve this agent.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <DeployReleaseAction agent={agent} />
          </EmptyContent>
        </Empty>
      ) : (
        live.map((deployment) => (
          <DeploymentCard agent={agent} deployment={deployment} key={deployment.id} />
        ))
      )}
      {stopped.length > 0 ? (
        <section className="flex flex-col gap-3">
          <Subheading>Stopped deployments</Subheading>
          <Table dense>
            <TableHeader>
              <TableRow>
                <TableHead>Deployment</TableHead>
                <TableHead>Release</TableHead>
                <TableHead>Stopped</TableHead>
                <TableHead className="text-right">Revision</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stopped.map((deployment) => (
                <TableRow key={deployment.id}>
                  <TableCell>
                    <PublicId value={deployment.id} />
                  </TableCell>
                  <TableCell>{releaseLabel(agent, deployment.agentReleaseId)}</TableCell>
                  <TableCell>
                    <Timestamp value={deployment.lastTransitionAt ?? deployment.updatedAt} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{deployment.version}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ) : null}
    </div>
  );
}
