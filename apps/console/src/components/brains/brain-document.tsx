import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  lifecycleCapture,
  lifecycleKinds,
  type BrainDocumentView,
  type CaptureBody,
  type LifecycleKind,
} from "../../brains/content.ts";
import { captureBrainLifecycleFn } from "../../data/brain-mutations.ts";
import { brainDocumentQuery, invalidateBrain } from "../../data/brain-queries.ts";
import { Button } from "@/components/ui/button";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { formatFileSize } from "@/components/ui/file-input";
import { Heading, Subheading } from "@/components/ui/heading";
import { Code } from "@/components/ui/text";
import { ActionDialog } from "../action-dialog.tsx";
import { useKeyedSnapshot } from "../keyed-snapshot.ts";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { StatusBadge } from "@/components/status-badge";

const LIFECYCLE_COPY: Readonly<
  Record<
    LifecycleKind,
    { readonly button: string; readonly description: string; readonly destructive: boolean }
  >
> = {
  archive: {
    button: "Archive",
    description: "Marks the document archived. Restore brings back its last content.",
    destructive: false,
  },
  restore: {
    button: "Restore",
    description: "Makes the document active again with the content it last held.",
    destructive: false,
  },
  tombstone: {
    button: "Tombstone",
    description:
      "Marks the document deleted, the only way to delete a Brain document. Its content stays, so Restore can bring it back.",
    destructive: true,
  },
};

export function BrainDocument({
  brainId,
  documentId,
  organizationId,
}: Readonly<{ brainId: string; documentId: string; organizationId: string }>) {
  const { document, version } = useSuspenseQuery(
    brainDocumentQuery(organizationId, brainId, documentId),
  ).data;
  const [capturing, setCapturing] = useState<LifecycleKind>();
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Heading level={2}>{document.title ?? document.externalItemIdentity}</Heading>
          <StatusBadge status={document.lifecycle} />
          <StatusBadge status={document.reviewStatus} />
          <div className="ml-auto flex gap-2">
            {lifecycleKinds(document).map((kind) => (
              <Button
                key={kind}
                onClick={() => setCapturing(kind)}
                variant={LIFECYCLE_COPY[kind].destructive ? "destructive" : "outline"}
              >
                {LIFECYCLE_COPY[kind].button}
              </Button>
            ))}
          </div>
        </div>
        <PublicId value={document.id} />
      </div>
      <section className="flex flex-col gap-4">
        <Subheading>Document</Subheading>
        <DescriptionList>
          <DescriptionTerm>Identity</DescriptionTerm>
          <DescriptionDetails>
            <Code>{document.externalItemIdentity}</Code>
          </DescriptionDetails>
          <DescriptionTerm>Source</DescriptionTerm>
          <DescriptionDetails>
            <PublicId value={document.sourceId} />
          </DescriptionDetails>
          <DescriptionTerm>Sensitivity</DescriptionTerm>
          <DescriptionDetails>{document.sensitivity}</DescriptionDetails>
          <DescriptionTerm>Content version</DescriptionTerm>
          <DescriptionDetails>
            {document.currentContentVersionId ? (
              <PublicId value={document.currentContentVersionId} />
            ) : (
              "None"
            )}
          </DescriptionDetails>
          <DescriptionTerm>Created</DescriptionTerm>
          <DescriptionDetails>
            <Timestamp value={document.createdAt} />
          </DescriptionDetails>
          <DescriptionTerm>Updated</DescriptionTerm>
          <DescriptionDetails>
            <Timestamp value={document.updatedAt} />
          </DescriptionDetails>
        </DescriptionList>
      </section>
      <section className="flex flex-col gap-4">
        <Subheading>Current version</Subheading>
        <DescriptionList>
          <DescriptionTerm>Version</DescriptionTerm>
          <DescriptionDetails>
            <PublicId value={version.id} />
          </DescriptionDetails>
          <DescriptionTerm>Kind</DescriptionTerm>
          <DescriptionDetails>{version.kind}</DescriptionDetails>
          {version.mediaType ? (
            <>
              <DescriptionTerm>Media type</DescriptionTerm>
              <DescriptionDetails>{version.mediaType}</DescriptionDetails>
            </>
          ) : null}
          {version.byteSize === undefined ? null : (
            <>
              <DescriptionTerm>Size</DescriptionTerm>
              <DescriptionDetails>{formatFileSize(version.byteSize)}</DescriptionDetails>
            </>
          )}
          {version.contentHash ? (
            <>
              <DescriptionTerm>Content hash</DescriptionTerm>
              <DescriptionDetails>
                <Code className="break-all">{version.contentHash}</Code>
              </DescriptionDetails>
            </>
          ) : null}
          {version.restoredContentVersionId ? (
            <>
              <DescriptionTerm>Restored version</DescriptionTerm>
              <DescriptionDetails>
                <PublicId value={version.restoredContentVersionId} />
              </DescriptionDetails>
            </>
          ) : null}
          <DescriptionTerm>Source order</DescriptionTerm>
          <DescriptionDetails>{version.sourceOrder}</DescriptionDetails>
          <DescriptionTerm>Captured</DescriptionTerm>
          <DescriptionDetails>
            <Timestamp value={version.createdAt} />
          </DescriptionDetails>
        </DescriptionList>
      </section>
      {capturing ? (
        <LifecycleDialog
          document={document}
          key={capturing}
          kind={capturing}
          onClose={() => setCapturing(undefined)}
          organizationId={organizationId}
        />
      ) : null}
    </div>
  );
}

function LifecycleDialog({
  document,
  kind,
  onClose,
  organizationId,
}: Readonly<{
  document: BrainDocumentView["document"];
  kind: LifecycleKind;
  onClose: () => void;
  organizationId: string;
}>) {
  const queryClient = useQueryClient();
  const held = useKeyedSnapshot<CaptureBody>();
  const copy = LIFECYCLE_COPY[kind];
  return (
    <ActionDialog
      confirmLabel={copy.button}
      confirmation={copy.destructive ? kind : undefined}
      description={copy.description}
      destructive={copy.destructive}
      onClose={onClose}
      onSuccess={(captured: BrainDocumentView) => {
        queryClient.setQueryData(
          brainDocumentQuery(organizationId, document.brainId, document.id).queryKey,
          captured,
        );
        void invalidateBrain(queryClient, organizationId, document.brainId);
      }}
      open
      retryNotice="The capture may already be recorded. Submit again to finish it."
      run={(idempotencyKey, resend) =>
        captureBrainLifecycleFn({
          data: {
            body: held(idempotencyKey, resend, lifecycleCapture(document, kind)),
            brainId: document.brainId,
            idempotencyKey,
            scope: { organizationId },
            sourceId: document.sourceId,
          },
        })
      }
      successMessage={`${copy.button} captured`}
      title={`${copy.button} ${document.title ?? document.externalItemIdentity}`}
    />
  );
}
