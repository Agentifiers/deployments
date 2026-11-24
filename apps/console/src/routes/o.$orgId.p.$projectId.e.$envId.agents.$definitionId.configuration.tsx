import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { DRAFT } from "../agents/release-selection.ts";
import { liveDeployments } from "../components/agents/agent-header.tsx";
import { ArchiveAgentSection } from "../components/agents/archive-dialogs.tsx";
import { DraftEditor } from "../components/agents/draft-editor.tsx";
import { ManifestView } from "../components/agents/manifest-view.tsx";
import { ReleaseDraftPanel } from "../components/agents/release-draft-panel.tsx";
import { ContentHash } from "../components/agents/release-table.tsx";
import { PublicId } from "../components/public-id.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { agentDetailQuery, invalidateAgent } from "../data/agent-queries.ts";
import { environmentQuery, organizationShellQuery } from "../data/console-queries.ts";
import { agentReleaseQuery } from "../data/release-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import type { AgentDetail } from "../server/agent-data.ts";
import { Field, Label } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";

export interface ConfigurationSearch {
  /** `draft` or the release ID pinned by a live deployment. */
  readonly source?: string;
}

/** The draft plus each release a live deployment pins, with the deployments pinning it. */
function manifestSources(agent: AgentDetail) {
  const pinned = new Map<string, string[]>();
  for (const deployment of liveDeployments(agent)) {
    pinned.set(deployment.agentReleaseId, [
      ...(pinned.get(deployment.agentReleaseId) ?? []),
      deployment.id,
    ]);
  }
  return [...pinned].map(([releaseId, deploymentIds]) => ({
    deploymentIds,
    release: agent.releases.find((release) => release.id === releaseId),
    releaseId,
  }));
}

/**
 * The draft manifest's editor and publish action, the published manifest each live deployment
 * runs (read-only), and archiving the agent.
 */
export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/agents/$definitionId/configuration",
)({
  validateSearch: (search): ConfigurationSearch =>
    typeof search.source === "string" ? { source: search.source } : {},
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
    const source = manifestSources(agent).find(({ releaseId }) => releaseId === deps.source);
    if (source) {
      void context.queryClient.prefetchQuery(
        agentReleaseQuery(scope, params.definitionId, source.releaseId),
      );
    }
  },
  component: Configuration,
});

function PublishedManifest({
  definitionId,
  releaseId,
  scope,
}: Readonly<{ definitionId: string; releaseId: string; scope: EnvironmentScope }>) {
  const { data: release } = useSuspenseQuery(agentReleaseQuery(scope, definitionId, releaseId));
  return (
    <div className="flex flex-col gap-3">
      <Text>
        Release #{release.releaseNumber} · <ContentHash value={release.contentHash} />
      </Text>
      <ManifestView
        label={`Release #${release.releaseNumber} manifest`}
        manifest={release.manifest}
      />
    </div>
  );
}

function Configuration() {
  const { definitionId, envId, orgId, projectId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const queryClient = useQueryClient();
  const { data: agent } = useSuspenseQuery(agentDetailQuery(scope, definitionId));
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const {
    data: { access },
  } = useSuspenseQuery(organizationShellQuery(orgId));
  const sources = manifestSources(agent);
  const published = sources.find(({ releaseId }) => releaseId === search.source);
  const editable = agent.definition.status === "active" && access.updateAgentDefinition;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-4">
        <Field className="w-96">
          <Label>Manifest</Label>
          <NativeSelect
            onChange={(event) =>
              void navigate({
                resetScroll: false,
                search: event.target.value === DRAFT ? {} : { source: event.target.value },
              })
            }
            value={published?.releaseId ?? DRAFT}
          >
            <option value={DRAFT}>Saved draft (draft {agent.definition.version})</option>
            {sources.map(({ deploymentIds, release, releaseId }) => (
              <option key={releaseId} value={releaseId}>
                Release {release ? `#${release.releaseNumber}` : `…${releaseId.slice(-8)}`} · pinned
                by {deploymentIds.length} live{" "}
                {deploymentIds.length === 1 ? "deployment" : "deployments"}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Text className="flex-1">
          {published
            ? "Published manifests are immutable. Edit the draft and publish it as a new release."
            : editable
              ? "Save the draft, then publish it as a release and deploy that release."
              : agent.definition.status === "active"
                ? "Your role or token scopes do not permit editing agents (agents:write)."
                : "Archived agents cannot be edited."}
        </Text>
      </div>
      {published ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Text>Pinned by</Text>
            {published.deploymentIds.map((id) => (
              <PublicId key={id} value={id} />
            ))}
          </div>
          <SectionBoundary
            fallback={<Skeleton className="h-96 rounded-lg" />}
            resetKey={published.releaseId}
          >
            <PublishedManifest
              definitionId={definitionId}
              releaseId={published.releaseId}
              scope={scope}
            />
          </SectionBoundary>
        </>
      ) : (
        <div className="flex flex-col gap-6">
          <SectionBoundary
            fallback={<Skeleton className="h-16 rounded-lg" />}
            resetKey={agent.releases[0]?.id ?? "none"}
          >
            <ReleaseDraftPanel
              agent={agent}
              canPublish={access.publishAgentRelease}
              environment={environment}
              scope={scope}
            />
          </SectionBoundary>
          {editable ? (
            <DraftEditor
              agent={agent}
              environment={environment}
              key={agent.definition.id}
              onRefresh={() => invalidateAgent(queryClient, scope, definitionId)}
              scope={scope}
            />
          ) : (
            <ManifestView label="Draft manifest" manifest={agent.definition.draft} />
          )}
          {access.archiveAgentDefinition ? (
            <ArchiveAgentSection agent={agent} environment={environment} scope={scope} />
          ) : null}
        </div>
      )}
    </div>
  );
}
