import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AddTraceToDataset } from "../components/evaluations/add-trace-to-dataset.tsx";
import { Icon } from "../components/icon.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { TraceDetail } from "../components/observability/trace-detail.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { agentDirectoryQuery, traceDetailQuery } from "../data/observability-queries.ts";
import { traceAnnotationsQuery, traceScoresQuery } from "../data/trace-feedback-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Heading } from "@/components/ui/heading";
import { Code } from "@/components/ui/text";

const SPAN_ID = /^[0-9a-f]{16}$/u;

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/traces/$traceId")({
  component: Trace,
  // `span` preselects one span, so a runtime log line can link to the span that wrote it.
  validateSearch: (search: Readonly<Record<string, unknown>>): { readonly span?: string } =>
    typeof search.span === "string" && SPAN_ID.test(search.span) ? { span: search.span } : {},
  loader: async ({ context, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    const { queryClient } = context;
    // Not awaited: the waterfall and the feedback footer stream into their boundaries while the
    // header renders.
    void queryClient.prefetchQuery(agentDirectoryQuery(scope));
    void queryClient.prefetchQuery(traceDetailQuery(scope, params.traceId));
    const { access } = await queryClient.ensureQueryData(organizationShellQuery(params.orgId));
    if (access.listTraceScoreResults) {
      void queryClient.prefetchQuery(traceScoresQuery(scope, params.traceId));
    }
    if (access.listTraceAnnotations) {
      void queryClient.prefetchQuery(traceAnnotationsQuery(scope, params.traceId));
    }
  },
});

function Trace() {
  const { envId, orgId, projectId, traceId } = Route.useParams();
  const { span } = Route.useSearch();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const { data: shell } = useSuspenseQuery(organizationShellQuery(orgId));
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
            Trace <Code>{traceId}</Code>
          </Heading>
          {shell.access.addDatasetCase && shell.access.listRegressionDatasets ? (
            <div className="ml-auto">
              <AddTraceToDataset scope={scope} traceId={traceId} />
            </div>
          ) : null}
        </div>
      </div>
      <SectionBoundary resetKey={traceId}>
        <TraceDetail initialSpanId={span} scope={scope} traceId={traceId} />
      </SectionBoundary>
    </div>
  );
}
