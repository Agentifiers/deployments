import { RefreshIcon } from "@hugeicons/core-free-icons";
import { useQueryErrorResetBoundary, useSuspenseQuery } from "@tanstack/react-query";
import { CatchBoundary, type ErrorComponentProps } from "@tanstack/react-router";
import { Suspense, type ReactNode } from "react";
import type { OperationAccess } from "../../access.ts";
import {
  connectionProblemsQuery,
  deploymentStatesQuery,
  failedDeliveriesQuery,
  pendingApprovalsQuery,
} from "../../data/overview-queries.ts";
import { UnauthenticatedError } from "../../errors.ts";
import {
  CONNECTION_PROBLEM_STATUSES,
  DEPLOYMENT_STATES,
  formatCount,
} from "../../overview/status-counts.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/components/ui/link";
import { Skeleton } from "@/components/ui/skeleton";
import { Code } from "@/components/ui/text";
import { Icon } from "../icon.tsx";
import { describeProblem } from "../section-boundary.tsx";
import { StatusBadge } from "@/components/status-badge";

/** A block's own failure, inline, so the rest of the strip keeps rendering. */
function BlockProblem({ error, reset }: ErrorComponentProps) {
  const queryErrors = useQueryErrorResetBoundary();
  // Sign-in loss affects the whole page; the page's boundary renders it.
  if (error instanceof UnauthenticatedError) throw error;
  const problem = describeProblem(error, "Unavailable");
  return (
    <div className="flex flex-col items-start gap-1 text-sm/6">
      <span className="font-medium text-destructive">{problem.title}</span>
      <span className="text-muted-foreground">
        {problem.description}
        {problem.requestId ? (
          <>
            {" "}
            Request <Code>{problem.requestId}</Code>.
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

function StatusBlock({
  action,
  children,
  className,
  resetKey,
  title,
}: Readonly<{
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  resetKey: string;
  title: string;
}>) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-sm/6 font-medium text-muted-foreground">{title}</CardTitle>
        {action ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      <CardContent>
        <CatchBoundary errorComponent={BlockProblem} getResetKey={() => resetKey}>
          <Suspense fallback={<Skeleton aria-busy="true" className="h-8 w-full rounded-md" />}>
            {children}
          </Suspense>
        </CatchBoundary>
      </CardContent>
    </Card>
  );
}

function Figure({
  children,
  label,
}: Readonly<{ children: ReactNode; label?: ReactNode | undefined }>) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-2xl/8 font-semibold tabular-nums">{children}</span>
      {label}
    </div>
  );
}

function DeploymentStates({ scope }: Readonly<{ scope: EnvironmentScope }>) {
  const { data } = useSuspenseQuery(deploymentStatesQuery(scope));
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-2">
      {DEPLOYMENT_STATES.map((state) => (
        <Figure key={state} label={<StatusBadge status={state} />}>
          {formatCount(data.counts[state], data.complete)}
        </Figure>
      ))}
    </div>
  );
}

function PendingApprovals({ scope }: Readonly<{ scope: EnvironmentScope }>) {
  const { data } = useSuspenseQuery(pendingApprovalsQuery(scope));
  return <Figure>{formatCount(data.count, data.complete)}</Figure>;
}

function FailedDeliveries({ scope }: Readonly<{ scope: EnvironmentScope }>) {
  const { data } = useSuspenseQuery(failedDeliveriesQuery(scope));
  return <Figure>{formatCount(data.count, data.complete)}</Figure>;
}

function ConnectionProblems({ scope }: Readonly<{ scope: EnvironmentScope }>) {
  const { data } = useSuspenseQuery(connectionProblemsQuery(scope));
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-2">
      {CONNECTION_PROBLEM_STATUSES.map((status) => (
        <Figure key={status} label={<StatusBadge status={status} />}>
          {formatCount(data.counts[status], data.complete)}
        </Figure>
      ))}
    </div>
  );
}

function BlockLink({ children, href }: Readonly<{ children: ReactNode; href: string }>) {
  return (
    <Link
      className="text-sm/6 font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
      href={href}
    >
      {children}
    </Link>
  );
}

/**
 * The overview's status strip (plan §5.1): deployments by state, pending approvals, connections
 * needing reauthorization or in error, and failed webhook deliveries. Each block renders only
 * when the caller may read its source and loads, refreshes, and fails on its own.
 */
export function StatusStrip({
  access,
  scope,
}: Readonly<{ access: OperationAccess; scope: EnvironmentScope }>) {
  const resetKey = scope.environmentId;
  const basePath = environmentPath(scope);
  if (
    !access.listAgentDeployments &&
    !access.listApprovals &&
    !access.listProviderConnections &&
    !access.listWebhookDeliveries
  ) {
    return null;
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
      {access.listAgentDeployments ? (
        <StatusBlock
          action={<BlockLink href={`${basePath}/agents`}>Agents</BlockLink>}
          className="sm:col-span-2"
          resetKey={resetKey}
          title="Deployments"
        >
          <DeploymentStates scope={scope} />
        </StatusBlock>
      ) : null}
      {access.listApprovals ? (
        <StatusBlock
          action={<BlockLink href={`${basePath}/approvals`}>Approvals</BlockLink>}
          resetKey={resetKey}
          title="Pending approvals"
        >
          <PendingApprovals scope={scope} />
        </StatusBlock>
      ) : null}
      {access.listProviderConnections ? (
        <StatusBlock
          action={<BlockLink href={`${basePath}/connections?status=attention`}>Review</BlockLink>}
          className="sm:col-span-2"
          resetKey={resetKey}
          title="Connections needing attention"
        >
          <ConnectionProblems scope={scope} />
        </StatusBlock>
      ) : null}
      {access.listWebhookDeliveries ? (
        <StatusBlock
          action={
            <BlockLink href={`${basePath}/webhooks/deliveries?status=failed`}>Deliveries</BlockLink>
          }
          resetKey={resetKey}
          title="Failed webhook deliveries"
        >
          <FailedDeliveries scope={scope} />
        </StatusBlock>
      ) : null}
    </div>
  );
}
