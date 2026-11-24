import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { NewExtension } from "../components/extensions/extension-editor.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { parseNewExtensionSearch, type NewExtensionSearch } from "../extensions/extension-state.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Text } from "@/components/ui/text";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/extensions/new")({
  validateSearch: (search): NewExtensionSearch => parseNewExtensionSearch(search),
  component: CreateExtension,
});

function CreateExtension() {
  const { envId, orgId, projectId } = Route.useParams();
  const search = parseNewExtensionSearch(Route.useSearch());
  const { access } = useSuspenseQuery(organizationShellQuery(orgId)).data;
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  if (!access.createExtensionTool) {
    return <Text>Your role or token scopes do not permit creating extensions (tools:write).</Text>;
  }
  return <NewExtension scope={scope} search={search} />;
}
