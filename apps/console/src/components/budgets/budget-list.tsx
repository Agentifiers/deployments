import { Wallet01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { formatBudgetUsd } from "../../budgets/budget-amount.ts";
import {
  BUDGET_VIEWS,
  PERIOD_COPY,
  type BudgetHealth,
  type BudgetView,
  type TargetIds,
} from "../../budgets/budget-state.ts";
import { budgetAlertsQuery, budgetPagesQuery } from "../../data/budget-queries.ts";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { formatExact } from "../../observability/format.ts";
import { oneOf } from "../../observability/range.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import type { OrganizationShell } from "../../server/console-data.ts";
import { Subheading } from "@/components/ui/heading";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Text } from "@/components/ui/text";
import { SingleToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ListEmpty, LoadMore } from "../list-controls.tsx";
import { useListCreateAction } from "../list-create-action.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { StatusBadge } from "@/components/status-badge";

const VIEW_LABELS: Readonly<Record<BudgetView, string>> = {
  all: "All budgets",
  applies: "Applies here",
};

/** Admission states worth a badge beside the status. */
const HEALTH_BADGES: Readonly<Partial<Record<BudgetHealth, string>>> = {
  "over-limit-paused": "over-limit",
  refusing: "refusing",
};

export function HealthBadge({ health }: Readonly<{ health: BudgetHealth }>) {
  const badge = HEALTH_BADGES[health];
  return badge ? <StatusBadge status={badge} /> : null;
}

export function BudgetTargetLabel({
  budget,
  projects,
}: Readonly<{
  budget: TargetIds;
  projects: OrganizationShell["projects"];
}>) {
  const entry = projects.find(({ project }) => project.id === budget.projectId);
  switch (budget.scope) {
    case "organization":
      return "Organization";
    case "project":
      return entry ? (
        `Project ${entry.project.name}`
      ) : (
        <>
          Project <PublicId value={budget.projectId ?? ""} />
        </>
      );
    case "environment": {
      const environment = entry?.environments.find(({ id }) => id === budget.environmentId);
      return entry && environment ? (
        `${entry.project.name} / ${environment.name}`
      ) : (
        <>
          Environment <PublicId value={budget.environmentId ?? ""} />
        </>
      );
    }
    case "workspace":
      return (
        <>
          Workspace <PublicId value={budget.workspaceId ?? ""} />
        </>
      );
  }
}

/**
 * Budgets whose current period crossed an alert threshold, across the organization. Each one
 * emitted a `budget.threshold-crossed` event when it crossed; this is the in-console record.
 */
export function BudgetAlertList({ scope }: Readonly<{ scope: EnvironmentScope }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data } = useSuspenseQuery(budgetAlertsQuery(scope));
  if (data.alerts.length === 0) return null;
  const basePath = `${environmentPath(scope)}/budgets`;
  return (
    <section aria-label="Budget alerts" className="flex flex-col gap-3">
      <Subheading>Alerts this period</Subheading>
      <Table dense>
        <TableHeader>
          <TableRow>
            <TableHead>Budget</TableHead>
            <TableHead>Target</TableHead>
            <TableHead className="text-right">Crossed</TableHead>
            <TableHead className="text-right">Spent</TableHead>
            <TableHead>Since</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.alerts.map(({ budget, current, percent, threshold }) => (
            <TableRow href={`${basePath}/${budget.id}`} key={budget.id} title={budget.name}>
              <TableCell>{budget.name}</TableCell>
              <TableCell>
                <BudgetTargetLabel budget={budget} projects={shell.projects} />
              </TableCell>
              <TableCell className="text-right tabular-nums">{threshold}%</TableCell>
              <TableCell className="text-right tabular-nums">
                {formatBudgetUsd(current.spendUsdMicros)} of{" "}
                {formatBudgetUsd(current.amountUsdMicros)} ({formatExact(percent)}%)
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <Timestamp value={current.periodStart} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {data.complete ? null : (
        <Text>Only the organization&apos;s newest 1,000 budgets were checked.</Text>
      )}
    </section>
  );
}

export function BudgetList({
  onView,
  scope,
  view,
}: Readonly<{
  onView: (view: BudgetView) => void;
  scope: EnvironmentScope;
  view: BudgetView;
}>) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <SingleToggleGroup
          aria-label="Budgets shown"
          onValueChange={(next) => {
            const nextView = oneOf(BUDGET_VIEWS, next);
            if (nextView) onView(nextView);
          }}
          size="sm"
          value={view}
        >
          {BUDGET_VIEWS.map((option) => (
            <ToggleGroupItem key={option} value={option}>
              {VIEW_LABELS[option]}
            </ToggleGroupItem>
          ))}
        </SingleToggleGroup>
      </div>
      <SectionBoundary resetKey={view}>
        <BudgetTable scope={scope} view={view} />
      </SectionBoundary>
    </div>
  );
}

function BudgetTable({ scope, view }: Readonly<{ scope: EnvironmentScope; view: BudgetView }>) {
  const createAction = useListCreateAction();
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const pagesQuery = budgetPagesQuery(scope, view);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const rows = data.pages.flatMap((page) => page.rows);
  const hidden = data.pages[0]?.hidden ?? 0;
  const complete = data.pages[0]?.complete ?? true;
  const basePath = `${environmentPath(scope)}/budgets`;
  return (
    <div className="flex flex-col gap-4">
      {view === "applies" ? (
        <Text>
          Showing the active and paused budgets that govern runs here.
          {hidden > 0
            ? ` ${formatExact(hidden)} ${hidden === 1 ? "other is" : "others are"} archived or apply elsewhere.`
            : null}
        </Text>
      ) : null}
      {complete ? null : <Text>Showing the organization&apos;s first 1,000 budgets.</Text>}
      {rows.length === 0 ? (
        <ListEmpty
          action={createAction}
          docs="/docs/capabilities/usage-and-budgets"
          icon={Wallet01Icon}
          title={view === "applies" ? "No budget applies to this environment" : "No budgets"}
        >
          A budget caps spend for the organization, a project, an environment, or one workspace, and
          refuses new runs once the period&apos;s spend reaches its amount.
        </ListEmpty>
      ) : (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Period</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="text-right">This period</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ budget, current, health, percent }) => (
              <TableRow href={`${basePath}/${budget.id}`} key={budget.id} title={budget.name}>
                <TableCell>{budget.name}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    <StatusBadge status={budget.status} />
                    <HealthBadge health={health} />
                  </div>
                </TableCell>
                <TableCell>
                  <BudgetTargetLabel budget={budget} projects={shell.projects} />
                </TableCell>
                <TableCell>{PERIOD_COPY[budget.period].label}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatBudgetUsd(budget.amountUsdMicros)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {current && percent !== undefined
                    ? `${formatBudgetUsd(current.spendUsdMicros)} (${formatExact(percent)}%)`
                    : "—"}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={budget.createdAt} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
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
