import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { SecretInventory } from "../components/secrets/secret-table.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { credentialReferencesQuery } from "../data/secrets-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { parseSecretSearch, type SecretSearch } from "../secrets/secret-state.ts";
import { Heading } from "@/components/ui/heading";
import { Text } from "@/components/ui/text";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/secrets")({
  validateSearch: (search): SecretSearch => parseSecretSearch(search),
  loaderDeps: ({ search }) => parseSecretSearch(search),
  loader: async ({ context, deps, params }) => {
    const { access } = await context.queryClient.ensureQueryData(
      organizationShellQuery(params.orgId),
    );
    if (!access.listCredentialReferences) return;
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchInfiniteQuery(credentialReferencesQuery(scope, deps.owner));
  },
  component: Secrets,
});

function Secrets() {
  const { envId, orgId, projectId } = Route.useParams();
  const { access } = useSuspenseQuery(organizationShellQuery(orgId)).data;
  const { owner } = parseSecretSearch(Route.useSearch());
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-6">
      <Heading>Secrets</Heading>
      <Text>
        Where this environment stores secrets and who holds each one. Values never leave the vault;
        rotate or revoke a secret from its owner.
      </Text>
      {access.listCredentialReferences ? (
        <SecretInventory
          onOwner={(next) => void navigate({ search: next === undefined ? {} : { owner: next } })}
          owner={owner}
          scope={scope}
        />
      ) : (
        <Text>Your role or token scopes do not permit listing secrets (secrets:read).</Text>
      )}
    </div>
  );
}
