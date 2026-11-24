import {
  Archive02Icon,
  DatabaseIcon,
  FileImportIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { organizationShellQuery } from "../../data/console-queries.ts";
import {
  datasetCasePagesQuery,
  datasetPagesQuery,
  datasetQuery,
} from "../../data/evaluation-queries.ts";
import { RESOURCE_STATUSES, type ResourceStatus } from "../../evaluations/filters.ts";
import { formatExact } from "../../observability/format.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import type { RegressionDataset } from "../../server/evaluation-data.ts";
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
import { Code, Text, TextLink } from "@/components/ui/text";
import { Icon } from "../icon.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import {
  ArchiveDatasetDialog,
  CreateDatasetDialog,
  ImportCasesDialog,
} from "./dataset-dialogs.tsx";
import { ListEmpty, FilterSelect, LoadMore } from "../list-controls.tsx";
import { StatusBadge } from "@/components/status-badge";

function retention({ retentionDays }: RegressionDataset) {
  if (retentionDays === undefined) return "—";
  return retentionDays === 1 ? "1 day" : `${formatExact(retentionDays)} days`;
}

/** The Datasets tab: every regression dataset, filtered by status. */
export function DatasetList({
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
        {shell.access.createRegressionDataset ? (
          <Button className="ml-auto" onClick={() => setCreating(true)}>
            <Icon icon={PlusSignIcon} />
            Create dataset
          </Button>
        ) : null}
      </div>
      <SectionBoundary resetKey={status ?? "all"}>
        <DatasetTable scope={scope} status={status} />
      </SectionBoundary>
      {shell.access.createRegressionDataset ? (
        <CreateDatasetDialog onClose={() => setCreating(false)} open={creating} scope={scope} />
      ) : null}
    </div>
  );
}

function DatasetTable({
  scope,
  status,
}: Readonly<{ scope: EnvironmentScope; status: ResourceStatus | undefined }>) {
  const pagesQuery = datasetPagesQuery(scope, status);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const datasets = data.pages.flatMap((page) => page.items);
  const basePath = `${environmentPath(scope)}/evaluations/datasets`;
  if (datasets.length === 0) {
    return (
      <ListEmpty docs="/docs/capabilities/evaluations" icon={DatabaseIcon} title="No datasets">
        Datasets hold the cases that evaluation runs replay.
      </ListEmpty>
    );
  }
  return (
    <>
      <Table striped>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Cases</TableHead>
            <TableHead>Retention</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead>ID</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {datasets.map((dataset) => (
            <TableRow href={`${basePath}/${dataset.id}`} key={dataset.id} title={dataset.name}>
              <TableCell>
                <Code>{dataset.name}</Code>
                {dataset.description ? (
                  <div className="max-w-80 truncate text-xs/5 text-muted-foreground">
                    {dataset.description}
                  </div>
                ) : null}
              </TableCell>
              <TableCell>
                <StatusBadge status={dataset.status} />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatExact(dataset.caseCount)}
              </TableCell>
              <TableCell>{retention(dataset)}</TableCell>
              <TableCell className="whitespace-nowrap">
                <Timestamp value={dataset.updatedAt} />
              </TableCell>
              <TableCell>
                <PublicId value={dataset.id} />
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

/** One dataset: its metadata, cases, and the import and archive actions. */
export function DatasetDetail({
  datasetId,
  scope,
}: Readonly<{ datasetId: string; scope: EnvironmentScope }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: dataset } = useSuspenseQuery(datasetQuery(scope, datasetId));
  const [dialog, setDialog] = useState<"archive" | "import">();
  const active = dataset.status === "active";
  const runsPath = `${environmentPath(scope)}/evaluations/runs?datasetId=${dataset.id}`;
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading level={2}>
          <Code>{dataset.name}</Code>
        </Heading>
        <StatusBadge status={dataset.status} />
        <div className="ml-auto flex gap-3">
          {active && shell.access.importDatasetCases ? (
            <Button onClick={() => setDialog("import")} variant="outline">
              <Icon icon={FileImportIcon} />
              Import cases
            </Button>
          ) : null}
          {active && shell.access.archiveRegressionDataset ? (
            <Button variant="destructive" onClick={() => setDialog("archive")}>
              <Icon icon={Archive02Icon} />
              Archive
            </Button>
          ) : null}
        </div>
      </div>
      {dataset.description ? <Text>{dataset.description}</Text> : null}
      <DescriptionList>
        <DescriptionTerm>ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={dataset.id} />
        </DescriptionDetails>
        <DescriptionTerm>Cases</DescriptionTerm>
        <DescriptionDetails>{formatExact(dataset.caseCount)}</DescriptionDetails>
        <DescriptionTerm>Retention</DescriptionTerm>
        <DescriptionDetails>{retention(dataset)}</DescriptionDetails>
        <DescriptionTerm>Created</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={dataset.createdAt} />
        </DescriptionDetails>
        {dataset.archivedAt ? (
          <>
            <DescriptionTerm>Archived</DescriptionTerm>
            <DescriptionDetails>
              <Timestamp value={dataset.archivedAt} />
            </DescriptionDetails>
          </>
        ) : null}
        <DescriptionTerm>Evaluation runs</DescriptionTerm>
        <DescriptionDetails>
          <TextLink href={runsPath}>Runs that replayed this dataset</TextLink>
        </DescriptionDetails>
      </DescriptionList>
      {shell.access.listDatasetCases ? (
        <section className="flex flex-col gap-4">
          <Subheading>Cases</Subheading>
          <SectionBoundary resetKey={dataset.id}>
            <CaseTable datasetId={dataset.id} scope={scope} />
          </SectionBoundary>
        </section>
      ) : null}
      {shell.access.importDatasetCases ? (
        <ImportCasesDialog
          dataset={dataset}
          onClose={() => setDialog(undefined)}
          open={dialog === "import"}
          scope={scope}
        />
      ) : null}
      {shell.access.archiveRegressionDataset ? (
        <ArchiveDatasetDialog
          dataset={dataset}
          onClose={() => setDialog(undefined)}
          open={dialog === "archive"}
          scope={scope}
        />
      ) : null}
    </div>
  );
}

function CaseTable({ datasetId, scope }: Readonly<{ datasetId: string; scope: EnvironmentScope }>) {
  const pagesQuery = datasetCasePagesQuery(scope, datasetId);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const cases = data.pages.flatMap((page) => page.items);
  if (cases.length === 0) {
    return (
      <ListEmpty docs="/docs/capabilities/evaluations" icon={FileImportIcon} title="No cases">
        Import a JSON case file to give evaluation runs something to replay.
      </ListEmpty>
    );
  }
  return (
    <>
      <Table dense striped>
        <TableHeader>
          <TableRow>
            <TableHead>Input</TableHead>
            <TableHead>External ID</TableHead>
            <TableHead>Expectations</TableHead>
            <TableHead>Provenance</TableHead>
            <TableHead>Tags</TableHead>
            <TableHead>Added</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {cases.map((item) => (
            <TableRow key={item.id}>
              <TableCell className="max-w-96 truncate" title={item.inputPreview}>
                {item.inputPreview}
              </TableCell>
              <TableCell>{item.externalId ? <Code>{item.externalId}</Code> : "—"}</TableCell>
              <TableCell>{item.expectationKinds.join(", ") || "—"}</TableCell>
              <TableCell>{item.provenance}</TableCell>
              <TableCell>{item.tags.join(", ") || "—"}</TableCell>
              <TableCell className="whitespace-nowrap">
                <Timestamp value={item.createdAt} />
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
