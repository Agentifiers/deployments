import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ExtensionList } from "../components/extensions/extension-list.tsx";
import { Icon } from "../components/icon.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { extensionPagesQuery } from "../data/extension-queries.ts";
import { parseExtensionSearch, type ExtensionSearch } from "../extensions/extension-state.ts";
import { environmentPath, type EnvironmentScope } from "../scope.ts";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/extensions/")({
  validateSearch: (search): ExtensionSearch => parseExtensionSearch(search),
  loaderDeps: ({ search }) => parseExtensionSearch(search),
  loader: ({ context, deps, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchInfiniteQuery(extensionPagesQuery(scope, deps));
  },
  component: Extensions,
});

function Extensions() {
  const { envId, orgId, projectId } = Route.useParams();
  const search = parseExtensionSearch(Route.useSearch());
  const navigate = Route.useNavigate();
  const { access } = useSuspenseQuery(organizationShellQuery(orgId)).data;
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const create = access.createExtensionTool ? (
    <Button href={`${environmentPath(scope)}/extensions/new`}>
      <Icon icon={PlusSignIcon} />
      Create extension
    </Button>
  ) : undefined;
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>Extensions</Heading>
        {create ? <div className="ml-auto">{create}</div> : null}
      </div>
      <SectionBoundary resetKey={envId}>
        <ExtensionList
          emptyAction={create}
          onSearch={(next) => void navigate({ search: next })}
          scope={scope}
          search={search}
        />
      </SectionBoundary>
    </div>
  );
}
