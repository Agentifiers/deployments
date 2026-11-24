import { GitCompareIcon, PlayIcon, TestTube01Icon } from "@hugeicons/core-free-icons";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { agentDetailQuery } from "../../data/agent-queries.ts";
import { organizationShellQuery } from "../../data/console-queries.ts";
import {
  activeScorersQuery,
  AGENT_TAB_RELEASES,
  agentEvaluationsQuery,
  datasetDirectoryQuery,
} from "../../data/evaluation-queries.ts";
import { agentDirectoryQuery } from "../../data/observability-queries.ts";
import { agentLabels } from "../../observability/agent-labels.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import { Subheading } from "@/components/ui/heading";
import { Text, TextLink } from "@/components/ui/text";
import { Icon } from "../icon.tsx";
import { ListEmpty } from "../list-controls.tsx";
import { ComparisonTable } from "./comparisons.tsx";
import { StartEvaluationRunDialog } from "./evaluation-run-dialog.tsx";
import { useDatasetNames } from "./list-controls.tsx";
import { StartReleaseComparisonDialog } from "./release-comparison-dialog.tsx";
import { RunTable } from "./runs.tsx";

/**
 * The agent's Evaluations tab (plan §6.1): evaluation runs that replayed its newest releases and
 * release comparisons with one of them as baseline or candidate.
 */
export function AgentEvaluations({
  definitionId,
  scope,
}: Readonly<{ definitionId: string; scope: EnvironmentScope }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: agent } = useSuspenseQuery(agentDetailQuery(scope, definitionId));
  const { data: directory } = useSuspenseQuery(agentDirectoryQuery(scope));
  const releaseIds = agent.releases.slice(0, AGENT_TAB_RELEASES).map((release) => release.id);
  const { data } = useSuspenseQuery(agentEvaluationsQuery(scope, releaseIds));
  const datasetNames = useDatasetNames(scope);
  const { data: datasets } = useSuspenseQuery(datasetDirectoryQuery(scope));
  const canStart = shell.access.createEvaluationRun || shell.access.createReleaseComparison;
  const scorers = useQuery({ ...activeScorersQuery(scope), enabled: canStart });
  const [dialog, setDialog] = useState<"comparison" | "run">();
  const labels = useMemo(
    () =>
      agentLabels(directory, [
        ...agent.releases.map((release) => ({
          definitionId: release.agentDefinitionId,
          id: release.id,
          releaseNumber: release.releaseNumber,
        })),
        ...data.releases,
      ]),
    [agent.releases, data.releases, directory],
  );
  const [newest, previous] = agent.releases;
  const evaluationsPath = `${environmentPath(scope)}/evaluations`;
  const missing = [
    datasets.some((dataset) => dataset.status === "active") ? undefined : "dataset",
    scorers.isSuccess && scorers.data.length === 0 ? "scorer" : undefined,
  ].filter((item) => item !== undefined);
  /** Both forms replay a dataset and score it, so they cannot be finished without both. */
  const unavailable =
    missing.length === 0 ? undefined : `Create a ${missing.join(" and a ")} to evaluate releases.`;
  const disabled = unavailable !== undefined || scorers.isPending;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Text>
          {agent.releases.length > AGENT_TAB_RELEASES
            ? `Evaluations of the newest ${AGENT_TAB_RELEASES} of ${agent.releases.length} releases.`
            : "Evaluations of this agent's releases."}
        </Text>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
          {canStart && newest && unavailable ? (
            <Text>
              {unavailable}{" "}
              <TextLink
                href={missing[0] === "dataset" ? evaluationsPath : `${evaluationsPath}/scorers`}
              >
                Open Evaluations
              </TextLink>
            </Text>
          ) : null}
          {shell.access.createEvaluationRun && newest ? (
            <Button disabled={disabled} onClick={() => setDialog("run")} variant="outline">
              <Icon icon={PlayIcon} />
              Start evaluation run
            </Button>
          ) : null}
          {shell.access.createReleaseComparison && newest ? (
            <Button disabled={disabled} onClick={() => setDialog("comparison")}>
              <Icon icon={GitCompareIcon} />
              Compare releases
            </Button>
          ) : null}
        </div>
      </div>

      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <Subheading>Evaluation runs</Subheading>
          <TextLink className="ml-auto text-sm/6" href={`${evaluationsPath}/runs`}>
            All runs
          </TextLink>
        </div>
        {data.runs.length === 0 ? (
          <ListEmpty docs="/docs/capabilities/evaluations" icon={TestTube01Icon} title="No runs">
            No dataset replay has targeted this agent's releases.
          </ListEmpty>
        ) : (
          <RunTable datasetNames={datasetNames} labels={labels} runs={data.runs} scope={scope} />
        )}
      </section>

      {shell.access.listReleaseComparisons ? (
        <section className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Subheading>Release comparisons</Subheading>
            <TextLink className="ml-auto text-sm/6" href={`${evaluationsPath}/comparisons`}>
              All comparisons
            </TextLink>
          </div>
          {data.comparisons.length === 0 ? (
            <ListEmpty
              docs="/docs/capabilities/evaluations"
              icon={GitCompareIcon}
              title="No comparisons"
            >
              No comparison has used this agent's releases as baseline or candidate.
            </ListEmpty>
          ) : (
            <ComparisonTable
              comparisons={data.comparisons}
              datasetNames={datasetNames}
              labels={labels}
              scope={scope}
            />
          )}
        </section>
      ) : null}

      {shell.access.createEvaluationRun ? (
        <StartEvaluationRunDialog
          agentReleaseId={newest?.id}
          onClose={() => setDialog(undefined)}
          open={dialog === "run"}
          scope={scope}
        />
      ) : null}
      {shell.access.createReleaseComparison ? (
        <StartReleaseComparisonDialog
          baselineReleaseId={previous?.id}
          candidateReleaseId={newest?.id}
          onClose={() => setDialog(undefined)}
          open={dialog === "comparison"}
          scope={scope}
        />
      ) : null}
    </div>
  );
}
