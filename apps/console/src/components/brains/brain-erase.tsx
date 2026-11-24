import type { BrainResponse } from "@deployments-ai/api-contract/brains";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  ERASE_PHRASE,
  erasurePhase,
  type BrainErasure,
  type ErasurePhase,
} from "../../brains/erasure.ts";
import { archiveBrainFn, eraseBrainFn } from "../../data/brain-mutations.ts";
import {
  brainErasureQuery,
  forgetArchivedBrain,
  invalidateBrains,
} from "../../data/brain-queries.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading, Subheading } from "@/components/ui/heading";
import { Text } from "@/components/ui/text";
import { ActionDialog, refreshOnConflict } from "../action-dialog.tsx";
import { useKeyedSnapshot } from "../keyed-snapshot.ts";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { StatusBadge } from "@/components/status-badge";

const ERASE_EFFECTS =
  "Erasing deletes every stored version of the Brain's documents, the memories derived from it, its search index entries, and its records. It runs in the background, can take about half an hour, and cannot be stopped or undone.";

function routeParams(scope: EnvironmentScope) {
  return { envId: scope.environmentId, orgId: scope.organizationId, projectId: scope.projectId };
}

export function ArchiveBrain({
  brain,
  scope,
}: Readonly<{ brain: BrainResponse; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const held = useKeyedSnapshot<number>();
  return (
    <section className="flex flex-col gap-4">
      <Subheading>Archive</Subheading>
      <Text>
        Archiving is permanent and hides the Brain. There is no unarchive. After archiving, you can
        erase its content.
      </Text>
      <div>
        <Button variant="destructive" onClick={() => setOpen(true)}>
          Archive Brain
        </Button>
      </div>
      <ActionDialog
        confirmLabel="Archive"
        confirmation="archive"
        description={
          <>
            Archiving {brain.name} is permanent. The Brain disappears from every list, and no one
            can read, search, or change it again. Its documents stay stored until you erase it,
            which the next page offers.
          </>
        }
        destructive
        onClose={() => setOpen(false)}
        onSuccess={(archived: BrainResponse) => {
          void navigate({
            params: { ...routeParams(scope), brainId: brain.id },
            search: { version: archived.version },
            to: "/o/$orgId/p/$projectId/e/$envId/brains/$brainId/erase",
          }).then(() => forgetArchivedBrain(queryClient, brain.organizationId, brain.id));
        }}
        open={open}
        retryNotice="The Brain may already be archived. Submitting again sends the same version, which the platform refuses if the archive already applied."
        run={(idempotencyKey, resend) =>
          refreshOnConflict(
            archiveBrainFn({
              data: {
                brainId: brain.id,
                expectedVersion: held(idempotencyKey, resend, brain.version),
                idempotencyKey,
                scope: { organizationId: brain.organizationId },
              },
            }),
            () => invalidateBrains(queryClient, brain.organizationId),
          )
        }
        successMessage="Brain archived"
        title={`Archive ${brain.name}`}
      />
    </section>
  );
}

export function EraseBrain({
  brainId,
  scope,
  version,
}: Readonly<{ brainId: string; scope: EnvironmentScope; version: number | undefined }>) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const brainsPath = `${environmentPath(scope)}/brains`;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Heading>Erase Brain</Heading>
        <div className="flex flex-wrap items-center gap-3">
          <PublicId value={brainId} />
          {version === undefined ? null : <Text>Version {version}</Text>}
        </div>
      </div>
      {version === undefined ? (
        <>
          <Callout>
            <CalloutTitle>Open this page by archiving the Brain</CalloutTitle>
            <CalloutDescription>
              <p>
                Erasing needs the version the archive returned, and an archived Brain cannot be read
                again, so this page works only from the link archiving opens.
              </p>
            </CalloutDescription>
          </Callout>
          <div>
            <Button href={brainsPath} variant="ghost">
              Back to Brains
            </Button>
          </div>
        </>
      ) : (
        <>
          <Text>{ERASE_EFFECTS}</Text>
          <Text>
            This page&apos;s address holds the version the archive returned. The console cannot read
            it again, so erase now or keep the address.
          </Text>
          <div className="flex flex-wrap gap-3">
            <Button variant="destructive" onClick={() => setOpen(true)}>
              Erase Brain
            </Button>
            <Button href={brainsPath} variant="ghost">
              Back to Brains
            </Button>
          </div>
          <ActionDialog
            confirmLabel="Erase"
            confirmation={ERASE_PHRASE}
            description={ERASE_EFFECTS}
            destructive
            onClose={() => setOpen(false)}
            onSuccess={(erasure: BrainErasure) =>
              void navigate({
                params: { ...routeParams(scope), brainId, erasureId: erasure.id },
                to: "/o/$orgId/p/$projectId/e/$envId/brains/$brainId/erasures/$erasureId",
              })
            }
            open={open}
            retryNotice="The erasure may have started. Submitting again sends the same request with the same key, and the platform usually answers with that erasure instead of starting another. If it answers that a request with this key is still in progress, an earlier attempt is running or has started the erasure, and the console cannot recover its receipt."
            run={(idempotencyKey) =>
              eraseBrainFn({
                data: {
                  brainId,
                  expectedVersion: version,
                  idempotencyKey,
                  scope: { organizationId: scope.organizationId },
                },
              })
            }
            successMessage="Erasure started"
            title="Erase this Brain"
          />
        </>
      )}
    </div>
  );
}

const PHASE_COPY: Readonly<Record<ErasurePhase["kind"], string>> = {
  erased:
    "Every stored document version, derived memory, search index entry, and record of the Brain is gone.",
  failed: "The erasure stopped. An operator can resume it with this erasure's ID.",
  queued: "The erasure is queued. This page refreshes every few seconds until it finishes.",
  running: "The Brain is being erased. This page refreshes every few seconds until it finishes.",
};

export function BrainErasureReceipt({
  brainId,
  erasureId,
  scope,
}: Readonly<{ brainId: string; erasureId: string; scope: EnvironmentScope }>) {
  const { data: erasure } = useSuspenseQuery(
    brainErasureQuery(scope.organizationId, brainId, erasureId),
  );
  const phase = erasurePhase(erasure);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <Heading>Brain erasure</Heading>
          <StatusBadge status={erasure.status} />
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <Text>
            Erasure <PublicId value={erasure.id} />
          </Text>
          <Text>
            Brain <PublicId value={erasure.brainId} />
          </Text>
        </div>
      </div>
      <Callout variant={phase.kind === "failed" ? "destructive" : "default"}>
        <CalloutTitle>{PHASE_COPY[phase.kind]}</CalloutTitle>
        {phase.kind === "failed" && phase.error ? (
          <CalloutDescription>
            <p>{phase.error}</p>
          </CalloutDescription>
        ) : null}
      </Callout>
      <Text>The API lists no erasures, so keep this page&apos;s address to check on it later.</Text>
      <DescriptionList>
        <DescriptionTerm>Requested</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={erasure.createdAt} />
        </DescriptionDetails>
        {erasure.startedAt ? (
          <>
            <DescriptionTerm>Started</DescriptionTerm>
            <DescriptionDetails>
              <Timestamp value={erasure.startedAt} />
            </DescriptionDetails>
          </>
        ) : null}
        {phase.kind === "erased" ? <ErasedEvidence phase={phase} /> : null}
      </DescriptionList>
    </div>
  );
}

function ErasedEvidence({ phase }: Readonly<{ phase: Extract<ErasurePhase, { kind: "erased" }> }>) {
  return (
    <>
      {phase.completedAt ? (
        <>
          <DescriptionTerm>Completed</DescriptionTerm>
          <DescriptionDetails>
            <Timestamp value={phase.completedAt} />
          </DescriptionDetails>
        </>
      ) : null}
      {phase.recordsDeleted === undefined ? null : (
        <>
          <DescriptionTerm>Records deleted</DescriptionTerm>
          <DescriptionDetails>{phase.recordsDeleted}</DescriptionDetails>
        </>
      )}
      <DescriptionTerm>Content absence checks</DescriptionTerm>
      <DescriptionDetails>{phase.contentChecks}</DescriptionDetails>
      <DescriptionTerm>Search index absence</DescriptionTerm>
      <DescriptionDetails>
        {phase.searchAbsenceRecorded ? "Recorded" : "Not recorded"}
      </DescriptionDetails>
    </>
  );
}
