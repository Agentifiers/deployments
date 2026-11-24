import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { parseDirectorySearch, type DirectorySearch } from "../api-keys/directory.ts";
import { ApiKeyDirectory, DirectoryViewToggle } from "../components/api-keys/api-key-directory.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { apiKeyDirectoryPagesQuery } from "../data/api-key-queries.ts";
import { organizationShellQuery } from "../data/console-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Heading } from "@/components/ui/heading";
import { Text } from "@/components/ui/text";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/api-keys/")({
  validateSearch: (search): DirectorySearch => parseDirectorySearch(search),
  loaderDeps: ({ search }) => parseDirectorySearch(search),
  loader: async ({ context, deps, params }) => {
    const { access } = await context.queryClient.ensureQueryData(
      organizationShellQuery(params.orgId),
    );
    if (access.listServiceAccounts && access.listApiCredentials) {
      void context.queryClient.prefetchInfiniteQuery(
        apiKeyDirectoryPagesQuery(
          {
            environmentId: params.envId,
            organizationId: params.orgId,
            projectId: params.projectId,
          },
          deps.show ?? "active",
        ),
      );
    }
  },
  component: ApiKeys,
});

function ApiKeys() {
  const { envId, orgId, projectId } = Route.useParams();
  const view = parseDirectorySearch(Route.useSearch()).show ?? "active";
  const navigate = Route.useNavigate();
  const { data: shell } = useSuspenseQuery(organizationShellQuery(orgId));
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const listable = shell.access.listServiceAccounts && shell.access.listApiCredentials;
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>API keys</Heading>
        {listable ? (
          <div className="ml-auto">
            <DirectoryViewToggle
              onChange={(next) => void navigate({ search: next === "all" ? { show: next } : {} })}
              value={view}
            />
          </div>
        ) : null}
      </div>
      {listable ? (
        <SectionBoundary resetKey={`${envId}:${view}`}>
          <ApiKeyDirectory scope={scope} view={view} />
        </SectionBoundary>
      ) : (
        <Text>
          Your role or token scopes do not permit listing service accounts and API keys
          (service-accounts:read, api-keys:read).
        </Text>
      )}
    </div>
  );
}
