import { RefreshIcon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import type { OperationAccess } from "../../access.ts";
import { organizationStandingQuery } from "../../data/organization-account-queries.ts";
import { useConsoleEdition } from "../../edition.ts";
import { PlatformApiError } from "../../errors.ts";
import type { OrganizationStanding } from "../../server/organization-account-data.ts";
import { Icon } from "../icon.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { ProblemReference } from "../section-boundary.tsx";
import { Button } from "@/components/ui/button";
import { Callout, CalloutAction, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Strong } from "@/components/ui/text";

const HOLD_REASONS: Readonly<Record<OrganizationStanding["holds"][number]["reason"], string>> = {
  abuse: "Abuse review",
  manual: "Operator hold",
  payment: "Payment",
  policy: "Policy review",
};

/** The standing banner, then the edition's notice, above every organization page. */
export function OrganizationNotices({
  access,
  organizationId,
}: Readonly<{ access: OperationAccess; organizationId: string }>) {
  const { organizationNotice: Notice } = useConsoleEdition();
  return (
    <>
      {access.getOrganizationStanding ? (
        <>
          <StandingBanner organizationId={organizationId} />
          <DataBoundaryNotice organizationId={organizationId} />
        </>
      ) : null}
      {Notice ? <Notice organizationId={organizationId} /> : null}
    </>
  );
}

/** The banner explains refusals and does not gate pages, so a failed read is a notice, not an error page. */
function StandingBanner({ organizationId }: Readonly<{ organizationId: string }>) {
  const {
    data: standing,
    error,
    isFetching,
    refetch,
  } = useQuery(organizationStandingQuery(organizationId));
  if (standing === undefined) {
    if (!error) return null;
    const problem = error instanceof PlatformApiError ? error.problem : undefined;
    return (
      <Callout className="mb-6">
        <CalloutTitle>Organization status could not be loaded</CalloutTitle>
        <CalloutDescription>
          <p>Any suspension notice appears here once the status loads.</p>
          <ProblemReference requestId={problem?.requestId} status={problem?.status} />
        </CalloutDescription>
        <CalloutAction>
          <Button disabled={isFetching} onClick={() => void refetch()} variant="outline">
            <Icon icon={RefreshIcon} />
            Retry
          </Button>
        </CalloutAction>
      </Callout>
    );
  }
  if (standing.state !== "suspended") return null;
  return (
    <Callout className="mb-6" variant="destructive">
      <CalloutTitle>This organization is suspended</CalloutTitle>
      <CalloutDescription>
        <p>
          Changes and new runs are refused until every hold is released. You can still view and
          export data, and stop, revoke, or remove access.
        </p>
        <ul className="mt-2 flex flex-col gap-2">
          {standing.holds.map((hold, index) => (
            <li key={index}>
              <Strong>{HOLD_REASONS[hold.reason]}</Strong> since <Timestamp value={hold.since} />.{" "}
              {hold.customerMessage}
            </li>
          ))}
        </ul>
      </CalloutDescription>
    </Callout>
  );
}

/** Read-only for members: only an operator sets or clears the boundary. */
function DataBoundaryNotice({ organizationId }: Readonly<{ organizationId: string }>) {
  const { data: standing } = useQuery(organizationStandingQuery(organizationId));
  const boundary = standing?.dataBoundary;
  if (!boundary) return null;
  return (
    <Callout className="mb-6">
      <CalloutTitle>This organization is under a PHI data boundary</CalloutTitle>
      <CalloutDescription>
        <p>
          Tools that reach the public internet and models outside Bedrock are unavailable. In place
          since <Timestamp value={boundary.since} />.
        </p>
      </CalloutDescription>
    </Callout>
  );
}
