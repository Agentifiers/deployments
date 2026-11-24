import { GitCompareIcon, PlayIcon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { StartEvaluationRunDialog } from "../components/evaluations/evaluation-run-dialog.tsx";
import { StartReleaseComparisonDialog } from "../components/evaluations/release-comparison-dialog.tsx";
import { Icon } from "../components/icon.tsx";
import { RouteTabs, type RouteTab } from "../components/route-tabs.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { environmentPath, type EnvironmentScope } from "../scope.ts";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";

/** Evaluations (plan §5.4): heading, start actions, and route tabs around the selected tab. */
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/evaluations")({
  component: EvaluationsLayout,
});

function EvaluationsLayout() {
  const { envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { data: shell } = useSuspenseQuery(organizationShellQuery(orgId));
  const { access } = shell;
  const [dialog, setDialog] = useState<"comparison" | "run">();
  const basePath = `${environmentPath(scope)}/evaluations`;
  // Detail pages keep their list's tab selected.
  const tab = (segment: string, label: string, ...prefixes: string[]): RouteTab => {
    const href = segment ? `${basePath}/${segment}` : basePath;
    const current =
      pathname === href || prefixes.some((prefix) => pathname.startsWith(`${basePath}/${prefix}/`));
    return { current, href, label };
  };
  const tabs = [
    ...(access.listRegressionDatasets ? [tab("", "Datasets", "datasets")] : []),
    ...(access.listScoreDefinitions ? [tab("scorers", "Scorers", "scorers")] : []),
    ...(access.listEvaluationRuns ? [tab("runs", "Runs", "runs")] : []),
    ...(access.listReleaseComparisons
      ? [tab("comparisons", "Release comparisons", "comparisons")]
      : []),
  ];

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>Evaluations</Heading>
        <div className="ml-auto flex gap-3">
          {access.createEvaluationRun ? (
            <Button onClick={() => setDialog("run")} variant="outline">
              <Icon icon={PlayIcon} />
              Start evaluation run
            </Button>
          ) : null}
          {access.createReleaseComparison ? (
            <Button onClick={() => setDialog("comparison")}>
              <Icon icon={GitCompareIcon} />
              Compare releases
            </Button>
          ) : null}
        </div>
      </div>
      <RouteTabs label="Evaluation sections" tabs={tabs} />
      <Outlet />
      {access.createEvaluationRun ? (
        <StartEvaluationRunDialog
          onClose={() => setDialog(undefined)}
          open={dialog === "run"}
          scope={scope}
        />
      ) : null}
      {access.createReleaseComparison ? (
        <StartReleaseComparisonDialog
          onClose={() => setDialog(undefined)}
          open={dialog === "comparison"}
          scope={scope}
        />
      ) : null}
    </div>
  );
}
