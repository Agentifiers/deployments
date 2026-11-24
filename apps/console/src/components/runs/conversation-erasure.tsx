import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading } from "@/components/ui/heading";
import { Code, Text } from "@/components/ui/text";
import { formatExact } from "../../observability/format.ts";
import { ERASURE_COUNTS, ERASURE_PHASES, erasureSettled } from "../../runs/erasure-state.ts";
import type { ConversationErasure } from "../../server/thread-data.ts";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { StatusBadge } from "@/components/status-badge";

const SUBJECTS = { "end-user": "End-user erasure", thread: "Thread erasure" } as const;

/** Progress and receipt of one thread or end-user erasure; it polls until the erasure settles. */
export function ConversationErasureStatus({ erasure }: Readonly<{ erasure: ConversationErasure }>) {
  const settled = erasureSettled(erasure);
  const current = ERASURE_PHASES.findIndex((entry) => entry.phase === erasure.phase);
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>{SUBJECTS[erasure.kind]}</Heading>
        <StatusBadge status={erasure.status} />
      </div>
      {erasure.status === "failed" && erasure.error ? (
        <Callout variant="destructive">
          <CalloutTitle>The erasure stopped before it finished</CalloutTitle>
          <CalloutDescription>
            <p>
              {erasure.error.message} <Code>{erasure.error.code}</Code>
            </p>
            <p>Request the erasure again to resume it; it continues the same request.</p>
          </CalloutDescription>
        </Callout>
      ) : null}
      {settled ? null : (
        <Text>
          Step {current + 1} of {ERASURE_PHASES.length}: {ERASURE_PHASES[current]?.label}. This page
          refreshes every few seconds until the erasure finishes.
        </Text>
      )}
      <DescriptionList>
        <DescriptionTerm>Erasure</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={erasure.id} />
        </DescriptionDetails>
        {erasure.threadId ? (
          <>
            <DescriptionTerm>Thread</DescriptionTerm>
            <DescriptionDetails>
              <PublicId value={erasure.threadId} />
            </DescriptionDetails>
          </>
        ) : null}
        <DescriptionTerm>Requested</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={erasure.createdAt} />
        </DescriptionDetails>
        <DescriptionTerm>{settled ? "Finished" : "Updated"}</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={erasure.completedAt ?? erasure.updatedAt} />
        </DescriptionDetails>
        {ERASURE_COUNTS.map(({ key, label }) => [
          <DescriptionTerm key={`${key}-term`}>{label}</DescriptionTerm>,
          <DescriptionDetails className="tabular-nums" key={`${key}-detail`}>
            {formatExact(erasure.counts[key])}
          </DescriptionDetails>,
        ])}
      </DescriptionList>
    </div>
  );
}
