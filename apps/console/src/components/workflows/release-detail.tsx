import { useSuspenseQuery } from "@tanstack/react-query";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { releaseQuery } from "../../data/workflow-queries.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading, Subheading } from "@/components/ui/heading";
import { CodeBlock } from "@/components/reui/code-block/code-block";
import { Code } from "@/components/ui/text";
import { Timestamp } from "../observability/panels.tsx";
import { BackLink } from "../back-link.tsx";
import { PublicId } from "../public-id.tsx";
import { ResourceLink } from "../resource-link.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { ArchiveReleaseAction, StartExecutionAction } from "./definition-actions.tsx";
import { RelatedExecutions } from "./definition-detail.tsx";
import { StatusBadge } from "@/components/status-badge";

export function ReleaseDetail({
  releaseId,
  scope,
}: Readonly<{ releaseId: string; scope: EnvironmentScope }>) {
  const release = useSuspenseQuery(releaseQuery(scope, releaseId)).data;
  const { access } = useSuspenseQuery(organizationShellQuery(scope.organizationId)).data;
  return (
    <div className="flex flex-col gap-10">
      <BackLink
        href={`${environmentPath(scope)}/workflows/${release.workflowDefinitionId}`}
        label={release.definition.name}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Heading level={2}>
          {release.definition.name} #{release.releaseNumber}
        </Heading>
        <StatusBadge status={release.status} />
        {release.status === "active" ? (
          <div className="ml-auto flex flex-wrap gap-3">
            {access.startWorkflowExecution ? (
              <StartExecutionAction release={release} scope={scope} />
            ) : null}
            {access.archiveWorkflowRelease ? (
              <ArchiveReleaseAction release={release} scope={scope} />
            ) : null}
          </div>
        ) : null}
      </div>
      <DescriptionList>
        <DescriptionTerm>ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={release.id} />
        </DescriptionDetails>
        <DescriptionTerm>Workflow</DescriptionTerm>
        <DescriptionDetails>
          <ResourceLink
            scope={scope}
            to={{ definitionId: release.workflowDefinitionId, kind: "workflowDefinition" }}
          >
            {release.definition.name}
          </ResourceLink>
        </DescriptionDetails>
        <DescriptionTerm>Content hash</DescriptionTerm>
        <DescriptionDetails>
          <Code className="break-all">{release.contentHash}</Code>
        </DescriptionDetails>
        <DescriptionTerm>Published by</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={release.createdByPrincipalId} />
        </DescriptionDetails>
        <DescriptionTerm>Published</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={release.createdAt} />
        </DescriptionDetails>
      </DescriptionList>
      <section className="flex flex-col gap-4">
        <Subheading>Definition</Subheading>
        <CodeBlock
          code={JSON.stringify(release.definition, null, 2)}
          label="Definition"
          language="json"
          maxLines={15}
        />
      </section>
      <section className="flex flex-col gap-4">
        <Subheading>Executions</Subheading>
        <SectionBoundary resetKey={releaseId}>
          <RelatedExecutions related={{ releaseId }} scope={scope} />
        </SectionBoundary>
      </section>
    </div>
  );
}
