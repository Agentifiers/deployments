import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { requestErasureFn } from "../../data/governance-mutations.ts";
import { erasureQuery, untilResumed } from "../../data/governance-queries.ts";
import {
  ERASE_PHRASE,
  ERASURE_BLOCKERS,
  type ErasureState,
} from "../../governance/erasure-state.ts";
import { formatExact } from "../../observability/format.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading } from "@/components/ui/heading";
import { Code, Text } from "@/components/ui/text";
import { ActionDialog } from "../action-dialog.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";

const STATE_BADGES = {
  blocked: { color: "amber", label: "blocked" },
  erased: { color: "green", label: "erased" },
  in_progress: { color: "blue", label: "in progress" },
  not_requested: { color: "zinc", label: "not requested" },
} as const satisfies Readonly<
  Record<
    ErasureState["kind"],
    { readonly color: "amber" | "blue" | "green" | "zinc"; readonly label: string }
  >
>;

function Blocked({
  organizationId,
  state,
}: Readonly<{ organizationId: string; state: Extract<ErasureState, { kind: "blocked" }> }>) {
  const queryClient = useQueryClient();
  const [resuming, setResuming] = useState(false);
  const [resumes, setResumes] = useState(0);
  const { data: shell } = useQuery(organizationShellQuery(organizationId));
  const { blocker } = state;
  useEffect(() => {
    if (resumes === 0) return;
    const page = new AbortController();
    void untilResumed(queryClient, erasureQuery(organizationId, state.operationId), page.signal);
    return () => page.abort();
  }, [organizationId, queryClient, resumes, state.operationId]);
  return (
    <>
      <Callout variant="destructive">
        <CalloutTitle>The erasure stopped before it finished</CalloutTitle>
        <CalloutDescription>
          <p>
            {blocker.kind === "other" ? (
              <>
                {blocker.error.message} <Code>{blocker.error.code}</Code>
              </>
            ) : (
              ERASURE_BLOCKERS[blocker.kind]
            )}
          </p>
          <p>Resolve that, then the person who requested the erasure can resume it.</p>
        </CalloutDescription>
      </Callout>
      {shell?.access.createTenantErasure ? (
        <>
          <div>
            <Button variant="destructive" onClick={() => setResuming(true)}>
              Resume erasure
            </Button>
          </div>
          <ActionDialog
            confirmLabel="Resume erasure"
            confirmation={ERASE_PHRASE}
            description="Resuming continues the same erasure from where it stopped."
            destructive
            onClose={() => setResuming(false)}
            onSuccess={() => setResumes((count) => count + 1)}
            open={resuming}
            run={(idempotencyKey) =>
              requestErasureFn({ data: { idempotencyKey, scope: { organizationId } } })
            }
            successMessage="Erasure resumed"
            title="Resume the erasure?"
          />
        </>
      ) : null}
    </>
  );
}

export function ErasureStatus({
  operationId,
  organizationId,
}: Readonly<{ operationId: string; organizationId: string }>) {
  const { data: state } = useSuspenseQuery(erasureQuery(organizationId, operationId));
  const badge = STATE_BADGES[state.kind];
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>Organization erasure</Heading>
        <Badge color={badge.color}>{badge.label}</Badge>
      </div>
      {state.kind === "in_progress" ? (
        <Text>
          The platform is stopping work and deleting records, files, indexes, and observability
          data. This page refreshes every few seconds.
        </Text>
      ) : null}
      {state.kind === "blocked" ? <Blocked organizationId={organizationId} state={state} /> : null}
      {state.kind === "erased" ? (
        <Text>
          The organization is erased. Its pages and API keys no longer work. Keep this receipt as
          proof of the erasure.
        </Text>
      ) : null}
      <DescriptionList>
        <DescriptionTerm>Organization</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={organizationId} />
        </DescriptionDetails>
        <DescriptionTerm>Erasure</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={operationId} />
        </DescriptionDetails>
        {state.kind === "in_progress" && state.startedAt ? (
          <>
            <DescriptionTerm>Started</DescriptionTerm>
            <DescriptionDetails>
              <Timestamp value={state.startedAt} />
            </DescriptionDetails>
          </>
        ) : null}
        {state.kind === "erased" ? (
          <>
            <DescriptionTerm>Finished</DescriptionTerm>
            <DescriptionDetails>
              <Timestamp value={state.completedAt} />
            </DescriptionDetails>
            {state.receipt ? (
              <>
                <DescriptionTerm>Records deleted</DescriptionTerm>
                <DescriptionDetails>{formatExact(state.receipt.recordsDeleted)}</DescriptionDetails>
                <DescriptionTerm>Audit chain root hash</DescriptionTerm>
                <DescriptionDetails>
                  <Code className="break-all">{state.receipt.auditRootHash}</Code>
                </DescriptionDetails>
                {state.receipt.memorySearch ? (
                  <>
                    <DescriptionTerm>Memory search backups expire by</DescriptionTerm>
                    <DescriptionDetails>
                      <Timestamp value={state.receipt.memorySearch.backupsExpireBy} />
                    </DescriptionDetails>
                  </>
                ) : null}
                {state.receipt.observability ? (
                  <>
                    <DescriptionTerm>Observability copies removed by</DescriptionTerm>
                    <DescriptionDetails>
                      <Timestamp value={state.receipt.observability.physicalRemovalBy} />
                    </DescriptionDetails>
                    <DescriptionTerm>Observability backups expire by</DescriptionTerm>
                    <DescriptionDetails>
                      <Timestamp value={state.receipt.observability.backupsExpireBy} />
                    </DescriptionDetails>
                  </>
                ) : null}
              </>
            ) : null}
          </>
        ) : null}
      </DescriptionList>
    </div>
  );
}
