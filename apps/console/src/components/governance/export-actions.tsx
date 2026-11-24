import { Download04Icon, FileLockedIcon } from "@hugeicons/core-free-icons";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { requestExportFn } from "../../data/governance-mutations.ts";
import { invalidateGovernance } from "../../data/governance-queries.ts";
import {
  EXPORT_SEGMENTS,
  type ExportKind,
  type OperationView,
} from "../../governance/operation-state.ts";
import { Button } from "@/components/ui/button";
import { ActionDialog } from "../action-dialog.tsx";
import { Icon } from "../icon.tsx";

const EXPORT_COPY = {
  "audit-export": {
    button: "Export audit log",
    confirm: "Start audit export",
    description:
      "Writes every organization and environment audit event recorded so far into a hash-chained archive and a signed manifest. Both files are locked against deletion until the audit retention period ends, and the signature and public key are inside the manifest.",
    icon: FileLockedIcon,
    title: "Export the audit log",
  },
  "tenant-export": {
    button: "Export data",
    confirm: "Start data export",
    description:
      "Writes every record this organization holds, with the files they reference, into one downloadable file with one JSON record per line. An export larger than 128 MiB is split into parts, and support can send you those.",
    icon: Download04Icon,
    title: "Export organization data",
  },
} as const satisfies Readonly<Record<ExportKind, unknown>>;

export function ExportActions({
  kinds,
  organizationId,
}: Readonly<{ kinds: readonly ExportKind[]; organizationId: string }>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [requesting, setRequesting] = useState<ExportKind>();
  return (
    <>
      {kinds.map((kind) => (
        <Button key={kind} onClick={() => setRequesting(kind)} variant="outline">
          <Icon icon={EXPORT_COPY[kind].icon} />
          {EXPORT_COPY[kind].button}
        </Button>
      ))}
      {requesting === undefined ? null : (
        <ActionDialog
          confirmLabel={EXPORT_COPY[requesting].confirm}
          description={EXPORT_COPY[requesting].description}
          onClose={() => setRequesting(undefined)}
          onSuccess={(operation: OperationView) => {
            void invalidateGovernance(queryClient, organizationId);
            void navigate({
              params: {
                kind: EXPORT_SEGMENTS[requesting],
                operationId: operation.id,
                orgId: organizationId,
              },
              to: "/o/$orgId/governance/$kind/$operationId",
            });
          }}
          open
          retryNotice="Try again to finish this export; the same request returns the same export."
          run={(idempotencyKey) =>
            requestExportFn({
              data: { idempotencyKey, kind: requesting, scope: { organizationId } },
            })
          }
          successMessage="Export started"
          title={EXPORT_COPY[requesting].title}
        />
      )}
    </>
  );
}
