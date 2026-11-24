import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ApiKeyDetail } from "../components/api-keys/api-key-detail.tsx";
import { Icon } from "../components/icon.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { parseKeyUsageSearch, type KeyUsageSearch } from "../api-keys/usage.ts";
import { apiKeyQuery, keyUsageQuery } from "../data/api-key-queries.ts";
import { organizationShellQuery } from "../data/console-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Text } from "@/components/ui/text";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/api-keys/$apiCredentialId")({
  validateSearch: (search): Partial<KeyUsageSearch> => parseKeyUsageSearch(search),
  loaderDeps: ({ search }) => parseKeyUsageSearch(search),
  loader: async ({ context, deps, params }) => {
    const { queryClient } = context;
    const { access } = await queryClient.ensureQueryData(organizationShellQuery(params.orgId));
    if (!access.listServiceAccounts || !access.listApiCredentials) return;
    const scope: EnvironmentScope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void queryClient.prefetchQuery(apiKeyQuery(scope, params.apiCredentialId));
    if (access.listApiCredentialUsage) {
      void queryClient.prefetchQuery(keyUsageQuery(scope, params.apiCredentialId, deps.window));
    }
  },
  component: ApiKey,
});

function ApiKey() {
  const { apiCredentialId, envId, orgId, projectId } = Route.useParams();
  const { window } = parseKeyUsageSearch(Route.useSearch());
  const navigate = Route.useNavigate();
  const { data: shell } = useSuspenseQuery(organizationShellQuery(orgId));
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-8">
      <Link
        className="flex items-center gap-1 text-sm/6 text-muted-foreground hover:text-foreground"
        params={{ envId, orgId, projectId }}
        to="/o/$orgId/p/$projectId/e/$envId/api-keys"
      >
        <Icon className="size-4" icon={ArrowLeft01Icon} />
        API keys
      </Link>
      {shell.access.listServiceAccounts && shell.access.listApiCredentials ? (
        <SectionBoundary resetKey={apiCredentialId}>
          <ApiKeyDetail
            apiCredentialId={apiCredentialId}
            onWindow={(next) => void navigate({ search: { window: next } })}
            scope={scope}
            window={window}
          />
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
