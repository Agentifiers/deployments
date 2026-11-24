import { RefreshIcon } from "@hugeicons/core-free-icons";
import { useQueryErrorResetBoundary, useSuspenseQuery } from "@tanstack/react-query";
import { CatchBoundary, type ErrorComponentProps } from "@tanstack/react-router";
import { Suspense } from "react";
import { formatBudgetUsd } from "../../budgets/budget-amount.ts";
import { refusalNotice } from "../../budgets/budget-refusal.ts";
import { PERIOD_COPY } from "../../budgets/budget-state.ts";
import { budgetRefusalsQuery } from "../../data/budget-queries.ts";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { UnauthenticatedError, type PlatformProblem } from "../../errors.ts";
import { formatExact } from "../../observability/format.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Code, Text, TextLink } from "@/components/ui/text";
import { Icon } from "../icon.tsx";
import { describeProblem } from "../section-boundary.tsx";

function BannerProblem({ error, reset }: ErrorComponentProps) {
  const queryErrors = useQueryErrorResetBoundary();
  if (error instanceof UnauthenticatedError) throw error;
  const problem = describeProblem(error, "Unavailable");
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm/6 text-muted-foreground">
      <span>
        <span className="font-medium text-destructive">Budgets could not be checked.</span>{" "}
        {problem.title}
        {problem.requestId ? (
          <>
            {" "}
            · Request <Code>{problem.requestId}</Code>
          </>
        ) : null}
      </span>
      <Button
        onClick={() => {
          queryErrors.reset();
          reset();
        }}
        variant="ghost"
      >
        <Icon icon={RefreshIcon} />
        Retry
      </Button>
    </div>
  );
}

const PARTIAL_SCAN =
  "Only the organization's newest 1,000 budgets were checked, so an older one that refuses new runs here is not shown.";

function RefusalCallout({ scope }: Readonly<{ scope: EnvironmentScope }>) {
  const { data } = useSuspenseQuery(budgetRefusalsQuery(scope));
  if (data.refusals.length === 0) return data.complete ? null : <Text>{PARTIAL_SCAN}</Text>;
  const basePath = `${environmentPath(scope)}/budgets`;
  return (
    <Callout variant="destructive">
      <CalloutTitle>New runs are refused in this environment</CalloutTitle>
      <CalloutDescription>
        <ul className="flex flex-col gap-1">
          {data.refusals.map(({ budget, current, percent }) => (
            <li key={budget.id}>
              <TextLink href={`${basePath}/${budget.id}`}>{budget.name}</TextLink> ({budget.scope})
              · {formatBudgetUsd(current.spendUsdMicros)} of{" "}
              {formatBudgetUsd(current.amountUsdMicros)} ({formatExact(percent)}%){" "}
              {PERIOD_COPY[budget.period].current}
            </li>
          ))}
        </ul>
        {data.complete ? null : <p>{PARTIAL_SCAN}</p>}
      </CalloutDescription>
    </Callout>
  );
}

/**
 * Names every budget refusing new runs here. Renders nothing while loading, or when none is and
 * every budget was checked.
 */
export function BudgetRefusalBanner({ scope }: Readonly<{ scope: EnvironmentScope }>) {
  return (
    <CatchBoundary errorComponent={BannerProblem} getResetKey={() => scope.environmentId}>
      <Suspense fallback={null}>
        <RefusalCallout scope={scope} />
      </Suspense>
    </CatchBoundary>
  );
}

type RefusalLinkProps = Readonly<{
  problem: Pick<PlatformProblem, "code" | "detail">;
  scope: EnvironmentScope;
}>;

function RefusalLink({ problem, scope }: RefusalLinkProps) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  if (!shell.access.listBudgets) return null;
  const notice = refusalNotice(problem);
  const basePath = `${environmentPath(scope)}/budgets`;
  return (
    <p>
      {notice && shell.access.getBudget ? (
        <TextLink href={`${basePath}/${notice.budgetId}`}>Open budget “{notice.name}”</TextLink>
      ) : (
        <TextLink href={basePath}>See budgets that apply here</TextLink>
      )}
    </p>
  );
}

/**
 * For a `budget_exhausted` problem, a link to the budget it names, or to the budgets that apply
 * here when the detail cannot be read. Renders nothing for any other problem, and reads the
 * organization shell only for this one.
 */
export function BudgetRefusalLink(props: RefusalLinkProps) {
  return props.problem.code === "budget_exhausted" ? <RefusalLink {...props} /> : null;
}
