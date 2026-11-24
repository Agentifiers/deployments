import { Archive02Icon, PauseIcon, PencilEdit02Icon, PlayIcon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ConsoleOperation } from "../../access.ts";
import { formatBudgetUsd, percentUsed } from "../../budgets/budget-amount.ts";
import {
  BUDGET_ACTIONS,
  budgetHealth,
  governs,
  type Budget,
  type BudgetAction,
  PERIOD_COPY,
} from "../../budgets/budget-state.ts";
import { budgetPeriodsQuery, budgetQuery } from "../../data/budget-queries.ts";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { formatExact } from "../../observability/format.ts";
import type { EnvironmentScope } from "../../scope.ts";
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
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Text } from "@/components/ui/text";
import { Icon } from "../icon.tsx";
import { LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { BudgetStatusDialog, EditBudgetDialog } from "./budget-dialogs.tsx";
import { BudgetTargetLabel, HealthBadge } from "./budget-list.tsx";
import { StatusBadge } from "@/components/status-badge";

const ACTION_CONTROLS: Readonly<
  Record<
    BudgetAction,
    { readonly icon: IconSvgElement; readonly label: string; readonly operation: ConsoleOperation }
  >
> = {
  archive: { icon: Archive02Icon, label: "Archive", operation: "archiveBudget" },
  edit: { icon: PencilEdit02Icon, label: "Edit", operation: "updateBudget" },
  pause: { icon: PauseIcon, label: "Pause", operation: "updateBudget" },
  resume: { icon: PlayIcon, label: "Resume", operation: "updateBudget" },
};

const UTC_TIME = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  hourCycle: "h23",
  timeStyle: "short",
  timeZone: "UTC",
});

export function BudgetDetail({
  budgetId,
  scope,
}: Readonly<{ budgetId: string; scope: EnvironmentScope }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: budget } = useSuspenseQuery(budgetQuery(scope, budgetId));
  const [dialog, setDialog] = useState<BudgetAction>();
  const { access } = shell;
  const actions = BUDGET_ACTIONS[budget.status].filter(
    (action) => access[ACTION_CONTROLS[action].operation],
  );
  const close = () => setDialog(undefined);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading level={2}>{budget.name}</Heading>
        <StatusBadge status={budget.status} />
        <div className="ml-auto flex flex-wrap gap-3">
          {actions.map((action) => {
            const { icon, label } = ACTION_CONTROLS[action];
            const content = (
              <>
                <Icon icon={icon} />
                {label}
              </>
            );
            return action === "archive" ? (
              <Button variant="destructive" key={action} onClick={() => setDialog(action)}>
                {content}
              </Button>
            ) : (
              <Button key={action} onClick={() => setDialog(action)} variant="outline">
                {content}
              </Button>
            );
          })}
        </div>
      </div>
      {governs(budget, scope) ? null : (
        <Text>This budget does not govern runs in this environment.</Text>
      )}
      {access.updateBudget || access.archiveBudget ? null : (
        <Text>Owners, admins, and billing members can change budgets.</Text>
      )}
      <DescriptionList>
        <DescriptionTerm>ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={budget.id} />
        </DescriptionDetails>
        <DescriptionTerm>Target</DescriptionTerm>
        <DescriptionDetails>
          <BudgetTargetLabel budget={budget} projects={shell.projects} />
        </DescriptionDetails>
        <DescriptionTerm>Period</DescriptionTerm>
        <DescriptionDetails>
          {PERIOD_COPY[budget.period].label}, on the UTC calendar
        </DescriptionDetails>
        <DescriptionTerm>Amount</DescriptionTerm>
        <DescriptionDetails className="tabular-nums">
          {formatBudgetUsd(budget.amountUsdMicros)}
        </DescriptionDetails>
        <DescriptionTerm>Alert thresholds</DescriptionTerm>
        <DescriptionDetails>
          {budget.thresholds.map((value) => `${value}%`).join(", ")}
        </DescriptionDetails>
        <DescriptionTerm>Version</DescriptionTerm>
        <DescriptionDetails className="tabular-nums">
          {formatExact(budget.version)}
        </DescriptionDetails>
        <DescriptionTerm>Created</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={budget.createdAt} />
        </DescriptionDetails>
        <DescriptionTerm>Updated</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={budget.updatedAt} />
        </DescriptionDetails>
        {budget.archivedAt ? (
          <>
            <DescriptionTerm>Archived</DescriptionTerm>
            <DescriptionDetails>
              <Timestamp value={budget.archivedAt} />
            </DescriptionDetails>
          </>
        ) : null}
      </DescriptionList>
      <section className="flex flex-col gap-4">
        <Subheading>Period history</Subheading>
        <Text>Past periods are measured against the budget&apos;s current amount.</Text>
        <SectionBoundary resetKey={`${budget.id}:${budget.version}`}>
          <PeriodHistory budget={budget} scope={scope} />
        </SectionBoundary>
      </section>
      {access.updateBudget ? (
        <EditBudgetDialog budget={budget} onClose={close} open={dialog === "edit"} scope={scope} />
      ) : null}
      {(["archive", "pause", "resume"] as const).map((change) =>
        access[ACTION_CONTROLS[change].operation] ? (
          <BudgetStatusDialog
            budget={budget}
            change={change}
            key={change}
            onClose={close}
            open={dialog === change}
            scope={scope}
          />
        ) : null,
      )}
    </div>
  );
}

function PeriodHistory({ budget, scope }: Readonly<{ budget: Budget; scope: EnvironmentScope }>) {
  const pagesQuery = budgetPeriodsQuery(scope, budget.id);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const periods = data.pages.flatMap((page) => page.items);
  const latest = periods[0];
  const health = budgetHealth(budget, latest);
  return (
    <>
      {latest?.current ? (
        <div className="flex flex-wrap items-center gap-2 text-sm/6">
          <span className="tabular-nums">
            {formatBudgetUsd(latest.spendUsdMicros)} of {formatBudgetUsd(latest.amountUsdMicros)}{" "}
            spent {PERIOD_COPY[budget.period].current} (
            {formatExact(percentUsed(latest.spendUsdMicros, latest.amountUsdMicros))}%)
          </span>
          <HealthBadge health={health} />
          {health === "refusing" ? <span>New runs it governs are refused.</span> : null}
        </div>
      ) : null}
      <Table dense striped>
        <TableHeader>
          <TableRow>
            <TableHead>Period (UTC)</TableHead>
            <TableHead className="text-right">Spend</TableHead>
            <TableHead className="text-right">Used</TableHead>
            <TableHead>Alerts sent</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {periods.map((period) => (
            <TableRow key={period.periodStart}>
              <TableCell className="whitespace-nowrap">
                {UTC_TIME.format(new Date(period.periodStart))} –{" "}
                {UTC_TIME.format(new Date(period.periodEnd))}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatBudgetUsd(period.spendUsdMicros)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatExact(percentUsed(period.spendUsdMicros, period.amountUsdMicros))}%
              </TableCell>
              <TableCell>
                {period.notifiedThresholds.map((value) => `${value}%`).join(", ") || "—"}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {period.current ? <Badge color="blue">current</Badge> : null}
                  {period.exhausted ? <Badge color="red">exhausted</Badge> : null}
                </div>
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
