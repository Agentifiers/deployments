import { Alert02Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { useQueryErrorResetBoundary } from "@tanstack/react-query";
import { CatchBoundary, type ErrorComponentProps } from "@tanstack/react-router";
import { Suspense, type ReactNode } from "react";
import { routerInstallCopy, type InstallCopy } from "../edition.ts";
import { PlatformApiError, UnauthenticatedError } from "../errors.ts";
import {
  OPERATION_PROBLEM_COPY,
  PROBLEM_COPY,
  REFUSED,
  type ProblemCopy,
} from "../problem-copy.ts";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Code, Text } from "@/components/ui/text";
import { SignInRequired } from "./console-states.tsx";
import { Icon } from "./icon.tsx";
import {
  isObservabilityUnavailable,
  ObservabilityUnavailable,
} from "./observability/unavailable.tsx";

type OperationCopy = Readonly<Record<string, Readonly<Record<string, ProblemCopy>>>>;

/**
 * What to tell the user about a failed request: RFC 7807 fields plus friendlier known codes.
 * The server's message (`detail`, else `title`) is the description unless the copy replaces it;
 * `description` is omitted when it would repeat the title.
 */
export function describeProblem(
  error: Error,
  fallbackTitle: string,
  operationCopy: OperationCopy = OPERATION_PROBLEM_COPY,
  installCopy: InstallCopy = routerInstallCopy(),
) {
  const problem = error instanceof PlatformApiError ? error.problem : undefined;
  const forOperation =
    error instanceof PlatformApiError
      ? operationCopy[error.operation]?.[error.problem.code ?? String(error.problem.status)]
      : undefined;
  const copy = forOperation ?? (problem?.code ? PROBLEM_COPY[problem.code] : undefined);
  const title = copy?.title ?? problem?.title ?? fallbackTitle;
  const description =
    (typeof copy?.description === "function" ? copy.description(installCopy) : copy?.description) ??
    (error instanceof PlatformApiError && error.problem.status === 403 && error.message === title
      ? REFUSED
      : error.message);
  return {
    description: description === title ? undefined : description,
    requestId: problem?.requestId,
    status: problem?.status,
    title,
  };
}

/** One-line request context for support: HTTP status and the API request ID. */
export function ProblemReference({
  requestId,
  status,
}: Readonly<{ requestId: string | undefined; status: number | undefined }>) {
  if (status === undefined && requestId === undefined) return null;
  return (
    <Text>
      {status === undefined ? null : `Status ${status}`}
      {status !== undefined && requestId ? " · " : null}
      {requestId ? (
        <>
          Request <Code>{requestId}</Code>
        </>
      ) : null}
    </Text>
  );
}

/** Inline error state for a page section; the page around it keeps rendering. */
function SectionProblem({ error, reset }: ErrorComponentProps) {
  // Suspense queries do not refetch a cached error on remount until the query error boundary is
  // reset, so "Try again" resets both boundaries.
  const queryErrors = useQueryErrorResetBoundary();
  if (error instanceof UnauthenticatedError) return <SignInRequired />;
  const retry = () => {
    queryErrors.reset();
    reset();
  };
  const retryButton = (
    <Button onClick={retry} variant="outline">
      <Icon icon={RefreshIcon} />
      Try again
    </Button>
  );
  if (isObservabilityUnavailable(error)) {
    return <ObservabilityUnavailable>{retryButton}</ObservabilityUnavailable>;
  }
  const problem = describeProblem(error, "This section failed to load");
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon icon={Alert02Icon} />
        </EmptyMedia>
        <EmptyTitle>{problem.title}</EmptyTitle>
        <EmptyDescription>
          {problem.description}
          {problem.requestId ? (
            <>
              {" "}
              Request <Code>{problem.requestId}</Code>.
            </>
          ) : null}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>{retryButton}</EmptyContent>
    </Empty>
  );
}

export function SectionSkeleton() {
  return (
    <div aria-busy="true" className="grid gap-4 lg:grid-cols-2">
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton className="h-72 rounded-xl" key={index} />
      ))}
    </div>
  );
}

/**
 * Loading and error boundary for asynchronous page content. `resetKey` changes with the
 * selection, so choosing another filter or range after a failure retries instead of keeping
 * the error.
 */
export function SectionBoundary({
  children,
  fallback = <SectionSkeleton />,
  resetKey,
}: Readonly<{ children: ReactNode; fallback?: ReactNode; resetKey: string }>) {
  return (
    <CatchBoundary errorComponent={SectionProblem} getResetKey={() => resetKey}>
      <Suspense fallback={fallback}>{children}</Suspense>
    </CatchBoundary>
  );
}
