import { useSuspenseQuery } from "@tanstack/react-query";
import { toolEvaluationsQuery } from "../../../data/agent-runtime-queries.ts";
import type { EnvironmentScope } from "../../../scope.ts";
import type { AgentDeployment, AgentDetail } from "../../../server/agent-data.ts";
import type { DeploymentToolEvaluation } from "../../../server/agent-runtime-data.ts";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { PublicId } from "../../public-id.tsx";
import { ProblemReference } from "../../section-boundary.tsx";
import { EvaluationTable } from "../../tools/evaluation-table.tsx";
import { liveDeployments, releaseLabel } from "../agent-header.tsx";
import { StatusBadge } from "@/components/status-badge";

function EvaluationBody({
  evaluation,
}: Readonly<{ evaluation: DeploymentToolEvaluation | undefined }>) {
  if (evaluation === undefined) return <Text>Not evaluated.</Text>;
  if ("problem" in evaluation) {
    const { problem } = evaluation;
    return (
      <Callout variant="destructive">
        <CalloutTitle>{problem.title}</CalloutTitle>
        <CalloutDescription>
          {problem.detail ?? "The tool policy evaluation failed."}
          <ProblemReference requestId={problem.requestId} status={problem.status} />
        </CalloutDescription>
      </Callout>
    );
  }
  if (evaluation.results.length === 0) {
    return <Text>The deployed release declares no tools.</Text>;
  }
  return <EvaluationTable results={evaluation.results} />;
}

function DeploymentEvaluation({
  agent,
  deployment,
  evaluation,
}: Readonly<{
  agent: AgentDetail;
  deployment: AgentDeployment;
  evaluation: DeploymentToolEvaluation | undefined;
}>) {
  const releaseId =
    evaluation && "results" in evaluation && evaluation.agentReleaseId
      ? evaluation.agentReleaseId
      : deployment.agentReleaseId;
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Deployment <PublicId value={deployment.id} />
          <StatusBadge status={deployment.currentState} />
        </CardTitle>
        <CardDescription>
          Release {releaseLabel(agent, releaseId)}
          {deployment.candidateAgentReleaseId
            ? ` (canary candidate ${releaseLabel(agent, deployment.candidateAgentReleaseId)} is not evaluated)`
            : null}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <EvaluationBody evaluation={evaluation} />
      </CardContent>
    </Card>
  );
}

/**
 * Each live deployment's effective tools from `POST /v1/tool-policies/evaluate`: the decision
 * the runtime would make for every tool its release declares, with the pinned policy and rule.
 */
export function EffectiveTools({
  agent,
  scope,
}: Readonly<{ agent: AgentDetail; scope: EnvironmentScope }>) {
  const live = liveDeployments(agent);
  const { data: evaluations } = useSuspenseQuery(
    toolEvaluationsQuery(
      scope,
      agent.definition.id,
      live.map((deployment) => deployment.id),
    ),
  );
  return (
    <div className="flex flex-col gap-4">
      {live.map((deployment) => (
        <DeploymentEvaluation
          agent={agent}
          deployment={deployment}
          evaluation={evaluations.find((entry) => entry.deploymentId === deployment.id)}
          key={deployment.id}
        />
      ))}
    </div>
  );
}
