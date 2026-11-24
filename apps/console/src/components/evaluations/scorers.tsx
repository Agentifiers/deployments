import { CheckListIcon, Edit02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { scorerPagesQuery, scorerQuery } from "../../data/evaluation-queries.ts";
import { RESOURCE_STATUSES, type ResourceStatus } from "../../evaluations/filters.ts";
import { formatScore } from "../../evaluations/format.ts";
import { formatPercent } from "../../observability/format.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { CodeBlock } from "@/components/reui/code-block/code-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  TableHeader,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { Code, Text } from "@/components/ui/text";
import { Icon } from "../icon.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { ListEmpty, FilterSelect, LoadMore } from "../list-controls.tsx";
import { ArchiveScorer, ScoreResults } from "./score-results.tsx";
import { CreateScorerDialog, ReviseScorerDialog } from "./scorer-dialogs.tsx";
import { StatusBadge } from "@/components/status-badge";

/** The Scorers tab: score definitions at their current revision, filtered by status. */
export function ScorerList({
  onStatus,
  scope,
  status,
}: Readonly<{
  onStatus: (status: ResourceStatus | undefined) => void;
  scope: EnvironmentScope;
  status: ResourceStatus | undefined;
}>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const [creating, setCreating] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <FilterSelect
          label="Status"
          onChange={(value) => onStatus(RESOURCE_STATUSES.find((candidate) => candidate === value))}
          options={RESOURCE_STATUSES.map((value) => ({ label: value, value }))}
          value={status}
        />
        {shell.access.createScoreDefinition ? (
          <Button className="ml-auto" onClick={() => setCreating(true)}>
            <Icon icon={PlusSignIcon} />
            Create scorer
          </Button>
        ) : null}
      </div>
      <SectionBoundary resetKey={status ?? "all"}>
        <ScorerTable scope={scope} status={status} />
      </SectionBoundary>
      {shell.access.createScoreDefinition ? (
        <CreateScorerDialog onClose={() => setCreating(false)} open={creating} scope={scope} />
      ) : null}
    </div>
  );
}

function ScorerTable({
  scope,
  status,
}: Readonly<{ scope: EnvironmentScope; status: ResourceStatus | undefined }>) {
  const pagesQuery = scorerPagesQuery(scope, status);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const scorers = data.pages.flatMap((page) => page.items);
  const basePath = `${environmentPath(scope)}/evaluations/scorers`;
  if (scorers.length === 0) {
    return (
      <ListEmpty docs="/docs/capabilities/evaluations" icon={CheckListIcon} title="No scorers">
        Scorers decide how evaluation runs grade each response.
      </ListEmpty>
    );
  }
  return (
    <>
      <Table striped>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Evaluator</TableHead>
            <TableHead className="text-right">Revision</TableHead>
            <TableHead className="text-right">Threshold</TableHead>
            <TableHead className="text-right">Sampling</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead>ID</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {scorers.map((scorer) => (
            <TableRow href={`${basePath}/${scorer.id}`} key={scorer.id} title={scorer.name}>
              <TableCell>
                <Code>{scorer.name}</Code>
              </TableCell>
              <TableCell>{scorer.type}</TableCell>
              <TableCell>
                <Code>{scorer.revision.evaluator.kind}</Code>
              </TableCell>
              <TableCell className="text-right tabular-nums">{scorer.currentRevision}</TableCell>
              <TableCell className="text-right tabular-nums">
                {formatScore(scorer.revision.threshold)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatPercent(scorer.revision.sampling.rate)}
              </TableCell>
              <TableCell>
                <StatusBadge status={scorer.status} />
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <Timestamp value={scorer.updatedAt} />
              </TableCell>
              <TableCell>
                <PublicId value={scorer.id} />
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
    </>
  );
}

/** One scorer: its current revision's configuration and the revise action. */
export function ScorerDetail({
  scope,
  scoreDefinitionId,
}: Readonly<{ scope: EnvironmentScope; scoreDefinitionId: string }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: scorer } = useSuspenseQuery(scorerQuery(scope, scoreDefinitionId));
  const [revising, setRevising] = useState(false);
  const { revision } = scorer;
  const canRevise = scorer.status === "active" && shell.access.reviseScoreDefinition;
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading level={2}>
          <Code>{scorer.name}</Code>
        </Heading>
        <StatusBadge status={scorer.status} />
        <Badge color="zinc">{scorer.type}</Badge>
        <div className="ml-auto flex gap-3">
          {canRevise ? (
            <Button onClick={() => setRevising(true)} variant="outline">
              <Icon icon={Edit02Icon} />
              Revise
            </Button>
          ) : null}
          {scorer.status === "active" && shell.access.archiveScoreDefinition ? (
            <ArchiveScorer scope={scope} scorer={scorer} />
          ) : null}
        </div>
      </div>
      {scorer.description ? <Text>{scorer.description}</Text> : null}
      <DescriptionList>
        <DescriptionTerm>ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={scorer.id} />
        </DescriptionDetails>
        <DescriptionTerm>Created</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={scorer.createdAt} />
        </DescriptionDetails>
        {scorer.archivedAt ? (
          <>
            <DescriptionTerm>Archived</DescriptionTerm>
            <DescriptionDetails>
              <Timestamp value={scorer.archivedAt} />
            </DescriptionDetails>
          </>
        ) : null}
      </DescriptionList>
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <Subheading>Revision {revision.revision}</Subheading>
          <StatusBadge status={revision.status} />
          <Text className="ml-auto">
            {scorer.currentRevision} revision{scorer.currentRevision === 1 ? "" : "s"}; the API
            returns the current one.
          </Text>
        </div>
        <DescriptionList>
          <DescriptionTerm>Created</DescriptionTerm>
          <DescriptionDetails>
            <Timestamp value={revision.createdAt} />
          </DescriptionDetails>
          <DescriptionTerm>Evaluator</DescriptionTerm>
          <DescriptionDetails>
            <Code>{revision.evaluator.kind}</Code>
          </DescriptionDetails>
          <DescriptionTerm>Target</DescriptionTerm>
          <DescriptionDetails>{revision.target}</DescriptionDetails>
          <DescriptionTerm>Threshold</DescriptionTerm>
          <DescriptionDetails>{formatScore(revision.threshold)}</DescriptionDetails>
          <DescriptionTerm>Sampling rate</DescriptionTerm>
          <DescriptionDetails>{formatPercent(revision.sampling.rate)}</DescriptionDetails>
          <DescriptionTerm>Weight</DescriptionTerm>
          <DescriptionDetails>{revision.weight ?? "—"}</DescriptionDetails>
          {revision.judgeModelId ? (
            <>
              <DescriptionTerm>Judge model</DescriptionTerm>
              <DescriptionDetails>
                <Code>{revision.judgeModelId}</Code>
              </DescriptionDetails>
            </>
          ) : null}
          <DescriptionTerm>Evaluator version</DescriptionTerm>
          <DescriptionDetails>
            <Code title={revision.evaluatorVersionHash}>
              {revision.evaluatorVersionHash.slice(0, 16)}…
            </Code>
          </DescriptionDetails>
        </DescriptionList>
        <CodeBlock code={revision.evaluator.json} label="Evaluator" language="json" maxLines={15} />
      </section>
      {shell.access.listScoreResults ? (
        <SectionBoundary resetKey={scorer.id}>
          <ScoreResults scope={scope} scoreDefinitionId={scorer.id} />
        </SectionBoundary>
      ) : null}
      {canRevise ? (
        <ReviseScorerDialog
          onClose={() => setRevising(false)}
          open={revising}
          scope={scope}
          scorer={scorer}
        />
      ) : null}
    </div>
  );
}
