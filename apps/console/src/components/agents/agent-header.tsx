import { ArrowLeft01Icon, BubbleChatIcon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { organizationShellQuery } from "../../data/console-queries.ts";
import type { AgentDetail } from "../../server/agent-data.ts";
import type { EnvironmentSummary } from "../../server/console-data.ts";
import { statusColor, statusLabel } from "../../status.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { Link } from "@/components/ui/link";
import { Code, Text } from "@/components/ui/text";
import { Icon } from "../icon.tsx";
import { EnvironmentTypeBadge } from "../organization-shell.tsx";
import { PublicId } from "../public-id.tsx";
import { DeploymentActions, DeployReleaseAction } from "./deployment-actions.tsx";
import { StatusBadge } from "@/components/status-badge";

/** Release number of a release ID among the agent's releases, else the ID's tail. */
export function releaseLabel(agent: AgentDetail, releaseId: string) {
  const release = agent.releases.find((candidate) => candidate.id === releaseId);
  return release ? `#${release.releaseNumber}` : `…${releaseId.slice(-8)}`;
}

/** Deployments that are not stopped: they serve traffic now or can be resumed. */
export function liveDeployments(agent: AgentDetail) {
  return agent.deployments.filter((deployment) => deployment.currentState !== "stopped");
}

/**
 * Agent detail header: name, slug, status, environment, and for the first live deployment its
 * state, pinned release, canary split, and operational actions. Deploying a release is offered
 * whenever the agent has an active release.
 */
export function AgentHeader({
  agent,
  agentsPath,
  environment,
}: Readonly<{ agent: AgentDetail; agentsPath: string; environment: EnvironmentSummary }>) {
  const { definition } = agent;
  const live = liveDeployments(agent);
  const primary = live[0];
  const { access } = useSuspenseQuery(organizationShellQuery(definition.organizationId)).data;
  const canChat = access.createThread && access.submitAgentRun && access.listRuns;
  return (
    <div className="flex flex-col gap-3">
      <Link
        className="inline-flex w-fit items-center gap-1 text-sm/6 text-muted-foreground hover:text-foreground"
        href={agentsPath}
      >
        <Icon className="size-4" icon={ArrowLeft01Icon} />
        Agents
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <Heading>{definition.name}</Heading>
        <EnvironmentTypeBadge type={environment.type} />
        {definition.status === "active" ? null : <StatusBadge status={definition.status} />}
        {primary ? (
          <Badge color={statusColor(primary.currentState)}>
            Deployment: {statusLabel(primary.currentState)}
          </Badge>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <Code>{definition.slug}</Code>
        <PublicId value={definition.id} />
        {primary ? (
          <>
            <Text>
              Release {releaseLabel(agent, primary.agentReleaseId)}
              {live.length > 1 ? ` · ${live.length} live deployments` : null}
            </Text>
            <span className="inline-flex items-center gap-1 text-sm/6 text-muted-foreground">
              Deployment <PublicId value={primary.id} />
            </span>
          </>
        ) : (
          <Text>No live deployment</Text>
        )}
      </div>
      {primary?.candidateAgentReleaseId && primary.candidateWeight !== undefined ? (
        <CanaryBar
          candidate={releaseLabel(agent, primary.candidateAgentReleaseId)}
          primary={releaseLabel(agent, primary.agentReleaseId)}
          weight={primary.candidateWeight}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {primary && canChat ? (
          <Button href={`${agentsPath}/${definition.id}/chat/${primary.id}`} variant="outline">
            <Icon icon={BubbleChatIcon} />
            Chat
          </Button>
        ) : null}
        <DeployReleaseAction agent={agent} />
        {primary ? <DeploymentActions agent={agent} deployment={primary} /> : null}
      </div>
    </div>
  );
}

/** The share of new threads each release of a canary receives. */
export function CanaryBar({
  candidate,
  primary,
  weight,
}: Readonly<{ candidate: string; primary: string; weight: number }>) {
  return (
    <div className="flex max-w-xl flex-col gap-1">
      <div
        aria-label={`Canary: ${candidate} receives ${weight}% of new threads`}
        className="flex h-2 overflow-hidden rounded-full bg-muted"
        role="img"
      >
        <div className="bg-amber-500" style={{ width: `${weight}%` }} />
      </div>
      <div className="flex justify-between text-xs/5 text-muted-foreground">
        <span>
          Primary {primary} · {100 - weight}%
        </span>
        <span>
          Canary {candidate} · {weight}%
        </span>
      </div>
    </div>
  );
}
