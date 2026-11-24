import { Download04Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  costRowsQuery,
  projectSpendQuery,
  workspaceSpendQuery,
} from "../../data/organization-account-queries.ts";
import type { InstallCopy } from "../../edition.ts";
import { formatUsdMicros } from "../../observability/format.ts";
import type { EnvironmentScope } from "../../scope.ts";
import type { OrganizationShell } from "../../server/console-data.ts";
import { costRowsCsv, spendingRows, type SpendRow } from "../../usage/organization-spend.ts";
import { downloadText } from "../download.ts";
import { Icon } from "../icon.tsx";
import { Button } from "@/components/ui/button";
import { SectionBoundary } from "../section-boundary.tsx";
import { Field, Label } from "@/components/ui/field";
import { Subheading } from "@/components/ui/heading";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Text } from "@/components/ui/text";

type Projects = OrganizationShell["projects"];

/** A month holds up to 744 hours per source; the table shows the latest and the CSV holds all. */
const SHOWN_COST_ROWS = 200;

function environmentScopes(organizationId: string, projects: Projects): EnvironmentScope[] {
  return projects.flatMap(({ environments, project }) =>
    environments.map((environment) => ({
      environmentId: environment.id,
      organizationId,
      projectId: project.id,
    })),
  );
}

function SpendTable({
  copy,
  label,
  noun,
  rows,
}: Readonly<{ copy: InstallCopy; label: string; noun: string; rows: readonly SpendRow[] }>) {
  const { idle, shown } = spendingRows(rows);
  if (shown.length === 0) {
    return <Text>No {noun} recorded spend in this month.</Text>;
  }
  return (
    <div className="flex flex-col gap-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{label}</TableHead>
            <TableHead className="text-right">{copy.operatorFundedLabel}</TableHead>
            <TableHead className="text-right">Organization keys</TableHead>
            <TableHead className="text-right">Total</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((row) => (
            <TableRow key={row.id}>
              <TableCell>
                {row.name}
                {row.within ? <span className="text-muted-foreground"> · {row.within}</span> : null}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatUsdMicros(row.operatorFundedUsdMicros)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatUsdMicros(row.organizationFundedUsdMicros)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatUsdMicros(row.totalUsdMicros)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {idle > 0 ? (
        <Text>
          {idle} more {idle === 1 ? noun.replace(/s$/u, "") : noun} recorded no spend.
        </Text>
      ) : null}
    </div>
  );
}

export function ProjectSpendSection({
  copy,
  month,
  organizationId,
  projects,
}: Readonly<{ copy: InstallCopy; month: string; organizationId: string; projects: Projects }>) {
  const { data } = useSuspenseQuery(projectSpendQuery(organizationId, month));
  const rows = data.map(({ projectId, ...split }) => ({
    ...split,
    id: projectId,
    name: projects.find(({ project }) => project.id === projectId)?.project.name ?? projectId,
  }));
  return <SpendTable copy={copy} label="Project" noun="projects" rows={rows} />;
}

function WorkspaceSpend({
  copy,
  month,
  scope,
}: Readonly<{ copy: InstallCopy; month: string; scope: EnvironmentScope }>) {
  const { data } = useSuspenseQuery(workspaceSpendQuery(scope, month));
  const rows = data.map(({ workspaceId, ...rest }) => ({ ...rest, id: workspaceId }));
  return <SpendTable copy={copy} label="Workspace" noun="workspaces" rows={rows} />;
}

/**
 * One environment's month at a time: its workspaces' spend, and its cost records with CSV
 * export. Both reads are environment-scoped, so the section picks the environment.
 */
export function EnvironmentSpendSection({
  copy,
  month,
  organizationId,
  projects,
  showCosts,
  showWorkspaces,
}: Readonly<{
  copy: InstallCopy;
  month: string;
  organizationId: string;
  projects: Projects;
  showCosts: boolean;
  showWorkspaces: boolean;
}>) {
  const scopes = environmentScopes(organizationId, projects);
  const [environmentId, setEnvironmentId] = useState(scopes[0]?.environmentId ?? "");
  const scope = scopes.find((candidate) => candidate.environmentId === environmentId);
  const environmentName = (id: string) => {
    for (const { environments, project } of projects) {
      const environment = environments.find((candidate) => candidate.id === id);
      if (environment) return `${project.name} / ${environment.name}`;
    }
    return id;
  };
  if (!scope) return <Text>The organization has no environment yet.</Text>;
  const resetKey = `${environmentId}/${month}`;
  return (
    <div className="flex flex-col gap-6">
      <Field className="max-w-md">
        <Label>Environment</Label>
        <NativeSelect
          onChange={(event) => setEnvironmentId(event.target.value)}
          value={environmentId}
        >
          {scopes.map((candidate) => (
            <option key={candidate.environmentId} value={candidate.environmentId}>
              {environmentName(candidate.environmentId)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {showWorkspaces ? (
        <div className="flex flex-col gap-3">
          <Subheading level={3}>Workspaces</Subheading>
          <SectionBoundary fallback={<Skeleton className="h-24 rounded-lg" />} resetKey={resetKey}>
            <WorkspaceSpend copy={copy} month={month} scope={scope} />
          </SectionBoundary>
        </div>
      ) : null}
      {showCosts ? (
        <div className="flex flex-col gap-3">
          <Subheading level={3}>Cost records</Subheading>
          <SectionBoundary fallback={<Skeleton className="h-32 rounded-lg" />} resetKey={resetKey}>
            <CostRecords environmentName={environmentName} month={month} scope={scope} />
          </SectionBoundary>
        </div>
      ) : null}
    </div>
  );
}

function CostRecords({
  environmentName,
  month,
  scope,
}: Readonly<{
  environmentName: (environmentId: string) => string;
  month: string;
  scope: EnvironmentScope;
}>) {
  const { data: rows } = useSuspenseQuery(costRowsQuery(scope, month));
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button
          disabled={rows.length === 0}
          onClick={() =>
            downloadText(
              costRowsCsv(rows, environmentName),
              `spend-${month}-${scope.environmentId}.csv`,
              "text/csv;charset=utf-8",
            )
          }
          variant="outline"
        >
          <Icon icon={Download04Icon} />
          Export CSV
        </Button>
      </div>
      {rows.length > SHOWN_COST_ROWS ? (
        <Text>
          Showing the latest {SHOWN_COST_ROWS} of {rows.length} rows. The CSV has every row.
        </Text>
      ) : null}
      {rows.length === 0 ? (
        <Text>This environment recorded no cost in this month.</Text>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Hour (UTC)</TableHead>
              <TableHead>Source</TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.slice(-SHOWN_COST_ROWS).map((row) => (
              <TableRow key={`${row.hour}/${row.source}`}>
                <TableCell className="tabular-nums">
                  {row.hour.slice(0, 16).replace("T", " ")}
                </TableCell>
                <TableCell>{row.source}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatUsdMicros(row.usdMicros)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
