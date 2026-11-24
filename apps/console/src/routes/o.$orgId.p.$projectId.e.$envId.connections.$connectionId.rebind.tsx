import { createFileRoute } from "@tanstack/react-router";
import { RebindPanel } from "../components/connections/rebind-panel.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { parseRebindSearch, type RebindSearch } from "../connections/rebind.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/connections/$connectionId/rebind",
)({
  validateSearch: (search): RebindSearch => parseRebindSearch(search),
  component: Rebind,
});

function Rebind() {
  const { connectionId, envId, orgId, projectId } = Route.useParams();
  const search = parseRebindSearch(Route.useSearch());
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={connectionId}>
      <RebindPanel
        connectionId={connectionId}
        onSearch={(next) => void navigate({ replace: true, search: next })}
        scope={scope}
        search={search}
      />
    </SectionBoundary>
  );
}
