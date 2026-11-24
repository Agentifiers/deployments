import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Icon } from "../components/icon.tsx";
import { SessionTraces } from "../components/observability/session-traces.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { agentDirectoryQuery, sessionTracePagesQuery } from "../data/observability-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Heading } from "@/components/ui/heading";
import { Code, TextLink } from "@/components/ui/text";

/** A session's ID is the thread's, so the page links back to the thread's transcript. */
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/traces/sessions/$sessionId")({
  loader: ({ context, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(agentDirectoryQuery(scope));
    void context.queryClient.prefetchInfiniteQuery(sessionTracePagesQuery(scope, params.sessionId));
  },
  component: Session,
});

function Session() {
  const { envId, orgId, projectId, sessionId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Link
          className="flex items-center gap-1 text-sm/6 text-muted-foreground hover:text-foreground"
          params={{ envId, orgId, projectId }}
          to="/o/$orgId/p/$projectId/e/$envId/traces"
        >
          <Icon className="size-4" icon={ArrowLeft01Icon} />
          Traces
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <Heading>
            Traces in thread <Code>{sessionId}</Code>
          </Heading>
          <TextLink
            className="ml-auto text-sm/6"
            href={`/o/${orgId}/p/${projectId}/e/${envId}/threads/${sessionId}`}
          >
            Open the thread
          </TextLink>
        </div>
      </div>
      <SectionBoundary resetKey={sessionId}>
        <SessionTraces scope={scope} sessionId={sessionId} />
      </SectionBoundary>
    </div>
  );
}
