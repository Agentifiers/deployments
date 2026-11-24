import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { EditExtension } from "../components/extensions/extension-editor.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { extensionQuery } from "../data/extension-queries.ts";
import { parseExtensionLocator } from "../extensions/extension-state.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Text } from "@/components/ui/text";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/extensions/$extensionId/edit",
)({
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
  component: EditExtensionPage,
});

function EditExtensionPage() {
  const { envId, extensionId, orgId, projectId } = Route.useParams();
  const search = parseExtensionLocator(Route.useSearch());
  const { access } = useSuspenseQuery(organizationShellQuery(orgId)).data;
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  if (!access.updateExtensionTool) {
    return <Text>Your role or token scopes do not permit editing extensions (tools:write).</Text>;
  }
  return (
    <SectionBoundary resetKey={extensionId}>
      <EditExtension locator={{ ...search, extensionId }} scope={scope} />
    </SectionBoundary>
  );
}
