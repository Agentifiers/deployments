import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AgentTable } from "../components/agents/agent-list.tsx";
import { CreateAgentDefinitionDialog } from "../components/agents/create-agent-dialog.tsx";
import { Icon } from "../components/icon.tsx";
import { RangeToggle } from "../components/observability/selection-controls.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { agentListMetricsQuery, agentListQuery } from "../data/agent-queries.ts";
import { environmentQuery, organizationShellQuery } from "../data/console-queries.ts";
import { parseMetricSelection, type MetricRange } from "../observability/range.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Button } from "@/components/ui/button";
import { Label, SwitchField } from "@/components/ui/field";
import { Heading } from "@/components/ui/heading";
import { Switch } from "@/components/ui/switch";

/** The agents list's URL search parameters. */
export interface AgentsSearch {
  readonly archived?: true;
  readonly range: MetricRange;
}

/** Reads the list's URL state: archived definitions are opt-in; the range defaults to 24 hours. */
function parseAgentsSearch(search: Readonly<Record<string, unknown>>): AgentsSearch {
  const archived = search.archived === true || search.archived === "true";
  return { range: parseMetricSelection(search).range, ...(archived ? { archived } : {}) };
}

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/agents/")({
  validateSearch: (search): Partial<AgentsSearch> => parseAgentsSearch(search),
  loaderDeps: ({ search }) => parseAgentsSearch(search),
  loader: async ({ context, deps, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    // Not awaited: the list and its metrics stream into the table while the header renders.
    void context.queryClient.prefetchQuery(agentListQuery(scope, deps.archived === true));
    const shell = await context.queryClient.ensureQueryData(organizationShellQuery(params.orgId));
    if (shell.access.getObservabilityMetrics) {
      void context.queryClient.prefetchQuery(agentListMetricsQuery(scope, deps.range));
    }
  },
  component: Agents,
});

function Agents() {
  const { envId, orgId, projectId } = Route.useParams();
  const search = parseAgentsSearch(Route.useSearch());
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const { data: shell } = useSuspenseQuery(organizationShellQuery(orgId));
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const includeArchived = search.archived === true;
  const showMetrics = shell.access.getObservabilityMetrics;
  const [creating, setCreating] = useState(false);
  const create = shell.access.createAgentDefinition ? (
    <Button onClick={() => setCreating(true)}>
      <Icon icon={PlusSignIcon} />
      Create agent
    </Button>
  ) : undefined;
  const select = (next: Partial<{ archived: boolean; range: MetricRange }>) => {
    const archived = next.archived ?? includeArchived;
    void navigate({
      search: { range: next.range ?? search.range, ...(archived ? { archived: true } : {}) },
    });
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-4">
        <Heading>Agents</Heading>
        <div className="ml-auto flex flex-wrap items-center gap-4">
          <SwitchField>
            <Label>Include archived</Label>
            <Switch
              checked={includeArchived}
              name="archived"
              onCheckedChange={(archived) => select({ archived })}
            />
          </SwitchField>
          {showMetrics ? (
            <RangeToggle onChange={(range) => select({ range })} value={search.range} />
          ) : null}
          {create}
        </div>
      </div>
      <SectionBoundary resetKey={`${includeArchived}`}>
        <AgentTable
          emptyAction={create}
          includeArchived={includeArchived}
          range={search.range}
          scope={scope}
          showMetrics={showMetrics}
        />
      </SectionBoundary>
      {creating ? (
        <CreateAgentDefinitionDialog
          canListWorkspaces={shell.access.listWorkspaces}
          environmentType={environment.type}
          onClose={() => setCreating(false)}
          scope={scope}
        />
      ) : null}
    </div>
  );
}
