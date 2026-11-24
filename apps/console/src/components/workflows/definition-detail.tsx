import { WorkflowSquare01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  definitionQuery,
  relatedExecutionsQuery,
  releasePagesQuery,
} from "../../data/workflow-queries.ts";
import { organizationShellQuery } from "../../data/console-queries.ts";
import type { EnvironmentScope } from "../../scope.ts";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading, Subheading } from "@/components/ui/heading";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CodeBlock } from "@/components/reui/code-block/code-block";
import { Code, Text } from "@/components/ui/text";
import { ListEmpty, LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { ResourceLink } from "../resource-link.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import {
  ArchiveDefinitionAction,
  EditDefinitionAction,
  PublishReleaseAction,
} from "./definition-actions.tsx";
import { ExecutionTable, StatusOrderNote } from "./execution-table.tsx";
import { StatusBadge } from "@/components/status-badge";

function Releases({
  definitionId,
  scope,
}: Readonly<{ definitionId: string; scope: EnvironmentScope }>) {
  const pagesQuery = releasePagesQuery(scope, definitionId);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const releases = data.pages.flatMap((page) => page.items);
  if (releases.length === 0) {
    return (
      <ListEmpty
        docs="/docs/capabilities/workflows"
        icon={WorkflowSquare01Icon}
        title="No releases"
      >
        Executions start from a release, an immutable copy of the draft.
      </ListEmpty>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <Table striped>
        <TableHeader>
          <TableRow>
            <TableHead>Release</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Content hash</TableHead>
            <TableHead>Published by</TableHead>
            <TableHead>Published</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {releases.map((release) => (
            <TableRow key={release.id}>
              <TableCell className="font-medium">
                <ResourceLink scope={scope} to={{ kind: "workflowRelease", releaseId: release.id }}>
                  #{release.releaseNumber}
                </ResourceLink>
              </TableCell>
              <TableCell>
                <StatusBadge status={release.status} />
              </TableCell>
              <TableCell>
                <Code title={release.contentHash}>{release.contentHash.slice(0, 19)}…</Code>
              </TableCell>
              <TableCell>
                <PublicId value={release.createdByPrincipalId} />
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <Timestamp value={release.createdAt} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <LoadMore
        error={error}
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        queryKey={pagesQuery.queryKey}
      />
    </div>
  );
}

export function RelatedExecutions({
  related,
  scope,
}: Readonly<{
  related: { readonly definitionId: string } | { readonly releaseId: string };
  scope: EnvironmentScope;
}>) {
  const { complete, items } = useSuspenseQuery(relatedExecutionsQuery(scope, related)).data;
  return (
    <div className="flex flex-col gap-4">
      {items.length === 0 && complete ? <Text>No executions yet.</Text> : null}
      {items.length > 0 ? (
        <>
          <StatusOrderNote />
          <ExecutionTable executions={items} scope={scope} />
        </>
      ) : null}
      {complete ? null : (
        <Text>
          The console read only the first pages of this environment's executions, because the API
          cannot filter executions by workflow or release. More may exist.
        </Text>
      )}
    </div>
  );
}

export function DefinitionDetail({
  definitionId,
  scope,
}: Readonly<{ definitionId: string; scope: EnvironmentScope }>) {
  const definition = useSuspenseQuery(definitionQuery(scope, definitionId)).data;
  const { access } = useSuspenseQuery(organizationShellQuery(scope.organizationId)).data;
  const editable = definition.status === "active";
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-wrap items-center gap-3">
        <Heading level={2}>{definition.name}</Heading>
        <StatusBadge status={definition.status} />
        {editable ? (
          <div className="ml-auto flex flex-wrap gap-3">
            {access.updateWorkflowDefinition ? (
              <EditDefinitionAction definition={definition} scope={scope} />
            ) : null}
            {access.publishWorkflowRelease ? (
              <PublishReleaseAction definition={definition} scope={scope} />
            ) : null}
            {access.archiveWorkflowDefinition ? (
              <ArchiveDefinitionAction definition={definition} scope={scope} />
            ) : null}
          </div>
        ) : null}
      </div>
      <DescriptionList>
        <DescriptionTerm>ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={definition.id} />
        </DescriptionDetails>
        <DescriptionTerm>Slug</DescriptionTerm>
        <DescriptionDetails>
          <Code>{definition.slug}</Code>
        </DescriptionDetails>
        <DescriptionTerm>Description</DescriptionTerm>
        <DescriptionDetails>{definition.draft.description ?? "—"}</DescriptionDetails>
        <DescriptionTerm>Draft version</DescriptionTerm>
        <DescriptionDetails>{definition.version}</DescriptionDetails>
        <DescriptionTerm>Steps</DescriptionTerm>
        <DescriptionDetails>
          {definition.draft.steps.length}, starting at <Code>{definition.draft.entryStepId}</Code>
        </DescriptionDetails>
        <DescriptionTerm>Created</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={definition.createdAt} />
        </DescriptionDetails>
        <DescriptionTerm>Updated</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={definition.updatedAt} />
        </DescriptionDetails>
      </DescriptionList>
      <section className="flex flex-col gap-4">
        <Subheading>Draft</Subheading>
        <CodeBlock
          code={JSON.stringify(definition.draft, null, 2)}
          label="Draft"
          language="json"
          maxLines={15}
        />
      </section>
      <section className="flex flex-col gap-4">
        <Subheading>Releases</Subheading>
        <SectionBoundary resetKey={definitionId}>
          <Releases definitionId={definitionId} scope={scope} />
        </SectionBoundary>
      </section>
      <section className="flex flex-col gap-4">
        <Subheading>Executions</Subheading>
        <SectionBoundary resetKey={definitionId}>
          <RelatedExecutions related={{ definitionId }} scope={scope} />
        </SectionBoundary>
      </section>
    </div>
  );
}
