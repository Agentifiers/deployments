import { PackageIcon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  DRAFT,
  parseReleaseSearch,
  resolveComparison,
  type ReleaseSearch,
} from "../agents/release-selection.ts";
import { Icon } from "../components/icon.tsx";
import { ArchiveReleaseDialog } from "../components/agents/archive-dialogs.tsx";
import { ReleaseCompare } from "../components/agents/release-compare.tsx";
import { ReleaseDetail } from "../components/agents/release-detail.tsx";
import { PromoteReleaseDialog } from "../components/agents/release-dialogs.tsx";
import { ReleaseDraftPanel } from "../components/agents/release-draft-panel.tsx";
import { ReleaseTable } from "../components/agents/release-table.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { agentDetailQuery } from "../data/agent-queries.ts";
import { environmentQuery, organizationShellQuery } from "../data/console-queries.ts";
import { agentReleaseQuery } from "../data/release-queries.ts";
import { environmentPath, type EnvironmentScope } from "../scope.ts";
import type { AgentReleaseSummary } from "../server/agent-data.ts";
import type { EnvironmentSummary } from "../server/console-data.ts";
import type { AgentRelease } from "../server/release-data.ts";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { TextLink } from "@/components/ui/text";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/agents/$definitionId/releases",
)({
  validateSearch: (search): ReleaseSearch => parseReleaseSearch(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps, params }) => {
    const scope: EnvironmentScope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    const agent = await context.queryClient.ensureQueryData(
      agentDetailQuery(scope, params.definitionId),
    );
    const releaseIds: readonly string[] = agent.releases.map((release) => release.id);
    const pair = resolveComparison(releaseIds, deps);
    // Not awaited: the latest release (for the draft check), the open release, and the compared
    // pair stream into their sections.
    for (const id of new Set([releaseIds[0], deps.release, pair?.baseline, pair?.candidate])) {
      if (id && id !== DRAFT && releaseIds.includes(id)) {
        void context.queryClient.prefetchQuery(agentReleaseQuery(scope, params.definitionId, id));
      }
    }
  },
  component: ReleasesTab,
});

/** The last promotion from this tab; the route component survives navigating to another agent. */
interface Promotion {
  readonly release: AgentRelease;
  readonly sourceDefinitionId: string;
  readonly target: EnvironmentSummary;
}

function ReleasesTab() {
  const { definitionId, envId, orgId, projectId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const { data: agent } = useSuspenseQuery(agentDetailQuery(scope, definitionId));
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const {
    data: { access },
  } = useSuspenseQuery(organizationShellQuery(orgId));
  const [promoting, setPromoting] = useState<AgentReleaseSummary>();
  const [archiving, setArchiving] = useState<AgentReleaseSummary>();
  const [promotion, setPromotion] = useState<Promotion>();
  const releaseIds: readonly string[] = agent.releases.map((release) => release.id);
  const pair = resolveComparison(releaseIds, search);
  const selected =
    search.release && releaseIds.includes(search.release) ? search.release : undefined;
  const select = (next: ReleaseSearch) =>
    void navigate({ resetScroll: false, search: (previous) => ({ ...previous, ...next }) });

  return (
    <div className="flex flex-col gap-8">
      <SectionBoundary
        fallback={<Skeleton className="h-24 rounded-lg" />}
        resetKey={agent.releases[0]?.id ?? "none"}
      >
        <ReleaseDraftPanel
          agent={agent}
          canPublish={access.publishAgentRelease}
          environment={environment}
          scope={scope}
        />
      </SectionBoundary>

      {promotion?.sourceDefinitionId === definitionId ? (
        <Callout>
          <CalloutTitle>
            Promoted to {promotion.target.name} as release #{promotion.release.releaseNumber}
          </CalloutTitle>
          <CalloutDescription>
            <TextLink
              href={`${environmentPath(promotion.release)}/agents/${promotion.release.agentDefinitionId}/releases`}
            >
              Open the agent in {promotion.target.name}
            </TextLink>{" "}
            to deploy it there.
          </CalloutDescription>
        </Callout>
      ) : null}

      {agent.releases.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Icon icon={PackageIcon} />
            </EmptyMedia>
            <EmptyTitle>No releases yet</EmptyTitle>
            <EmptyDescription>
              Edit the draft on the Configuration tab, then publish it to create release #1.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ReleaseTable
          agent={agent}
          canArchive={access.archiveAgentRelease}
          canPromote={access.promoteAgentRelease}
          onArchive={setArchiving}
          onPromote={setPromoting}
          onShow={(release) => select({ release })}
          selectedId={selected}
        />
      )}

      {selected ? (
        <SectionBoundary fallback={<Skeleton className="h-72 rounded-lg" />} resetKey={selected}>
          <ReleaseDetail
            definitionId={definitionId}
            onClose={() =>
              void navigate({
                resetScroll: false,
                search: ({ release: _closed, ...previous }) => previous,
              })
            }
            releaseId={selected}
            scope={scope}
          />
        </SectionBoundary>
      ) : null}

      {pair ? (
        <ReleaseCompare
          agent={agent}
          canStartComparison={access.createReleaseComparison}
          onChange={(next) => select(next)}
          pair={pair}
          scope={scope}
        />
      ) : null}

      {access.archiveAgentRelease ? (
        <ArchiveReleaseDialog
          agent={agent}
          environment={environment}
          onClose={() => setArchiving(undefined)}
          release={archiving}
          scope={scope}
        />
      ) : null}

      {access.promoteAgentRelease ? (
        <PromoteReleaseDialog
          agent={agent}
          onClose={() => setPromoting(undefined)}
          onPromoted={(release, target) =>
            setPromotion({ release, sourceDefinitionId: definitionId, target })
          }
          release={promoting}
          scope={scope}
        />
      ) : null}
    </div>
  );
}
