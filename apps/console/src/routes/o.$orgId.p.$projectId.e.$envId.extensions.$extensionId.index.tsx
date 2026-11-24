import { createFileRoute } from "@tanstack/react-router";
import { BackLink } from "../components/back-link.tsx";
import { ExtensionDetail } from "../components/extensions/extension-detail.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { extensionQuery } from "../data/extension-queries.ts";
import { parseExtensionLocator } from "../extensions/extension-state.ts";
import type { EnvironmentScope } from "../scope.ts";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/extensions/$extensionId/")({
  validateSearch: parseExtensionLocator,
  loaderDeps: ({ search }) => parseExtensionLocator(search),
  loader: ({ context, deps, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(
      extensionQuery(scope, { ...deps, extensionId: params.extensionId }),
    );
  },
  component: Extension,
});

function Extension() {
  const { envId, extensionId, orgId, projectId } = Route.useParams();
  const search = parseExtensionLocator(Route.useSearch());
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-8">
      <BackLink href={`/o/${orgId}/p/${projectId}/e/${envId}/extensions`} label="Extensions" />
      <SectionBoundary resetKey={extensionId}>
        <ExtensionDetail locator={{ ...search, extensionId }} scope={scope} />
      </SectionBoundary>
    </div>
  );
}
