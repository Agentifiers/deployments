import { Upload01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  ArtifactBrowser,
  type ArtifactFilterPatch,
} from "../components/artifacts/artifact-browser.tsx";
import { UploadArtifactDialog } from "../components/artifacts/upload-dialog.tsx";
import { Icon } from "../components/icon.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { agentDirectoryQuery } from "../data/observability-queries.ts";
import { artifactPagesQuery } from "../data/thread-queries.ts";
import { parseArtifactFilters, type ArtifactFilters } from "../artifacts/filters.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/artifacts/")({
  validateSearch: (search): ArtifactFilters => parseArtifactFilters(search),
  loaderDeps: ({ search }) => parseArtifactFilters(search),
  loader: ({ context, deps, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(agentDirectoryQuery(scope));
    void context.queryClient.prefetchInfiniteQuery(
      artifactPagesQuery(scope, { filters: deps, kind: "environment" }),
    );
  },
  component: Artifacts,
});

function Artifacts() {
  const { envId, orgId, projectId } = Route.useParams();
  const filters = parseArtifactFilters(Route.useSearch());
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const { access } = useSuspenseQuery(organizationShellQuery(orgId)).data;
  const [uploading, setUploading] = useState(false);
  const canUpload = access.createArtifactUpload && access.completeArtifactUpload;
  const filter = (patch: ArtifactFilterPatch) =>
    void navigate({ resetScroll: false, search: parseArtifactFilters({ ...filters, ...patch }) });
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>Artifacts</Heading>
        {canUpload ? (
          <Button className="ml-auto" onClick={() => setUploading(true)}>
            <Icon icon={Upload01Icon} />
            Upload
          </Button>
        ) : null}
      </div>
      <SectionBoundary resetKey={JSON.stringify(filters)}>
        <ArtifactBrowser
          filters={filters}
          onFilter={filter}
          onUpload={canUpload ? () => setUploading(true) : undefined}
          scope={scope}
        />
      </SectionBoundary>
      {canUpload ? (
        <UploadArtifactDialog onClose={() => setUploading(false)} open={uploading} scope={scope} />
      ) : null}
    </div>
  );
}
