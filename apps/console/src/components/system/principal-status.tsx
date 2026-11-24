import { SYSTEM_PRINCIPAL_STATUSES } from "@deployments-ai/api-contract/system";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { replacePrincipalStatusFn } from "../../data/system-mutations.ts";
import { invalidatePerson } from "../../data/system-queries.ts";
import { Code } from "@/components/ui/text";
import { ActionDialog } from "../action-dialog.tsx";
import { ReasonField, reasonProblem } from "./person-dialogs.tsx";

export type PrincipalStatus = (typeof SYSTEM_PRINCIPAL_STATUSES)[number];

const STATUS_COPY: Readonly<
  Record<
    PrincipalStatus,
    { readonly action: string; readonly description: string; readonly verb: string }
  >
> = {
  active: {
    action: "Enable",
    description:
      "Restores sign-in. Sessions that ended when the person was disabled stay ended, so they sign in again.",
    verb: "enable",
  },
  disabled: {
    action: "Disable",
    description:
      "Refuses the person's credentials everywhere in the install and ends their browser sessions, refresh tokens, and device grants. Their next API request returns 401.",
    verb: "disable",
  },
};

/** The phrase to type: the action and the ID's tail, so a pasted wrong ID does not confirm. */
export function statusConfirmation(status: PrincipalStatus, principalId: string): string {
  return `${STATUS_COPY[status].verb} ${principalId.slice(-8)}`;
}

export function PrincipalStatusDialog({
  onClose,
  principalId,
  status,
}: Readonly<{ onClose: () => void; principalId: string; status: PrincipalStatus }>) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const copy = STATUS_COPY[status];
  return (
    <ActionDialog
      confirmLabel={`${copy.action} person`}
      confirmation={statusConfirmation(status, principalId)}
      description={copy.description}
      destructive={status === "disabled"}
      invalid={reasonProblem(reason) !== undefined}
      onClose={onClose}
      onSuccess={() => void invalidatePerson(queryClient, principalId)}
      open
      runOnce={() =>
        replacePrincipalStatusFn({ data: { body: { reason: reason.trim(), status }, principalId } })
      }
      size="xl"
      successMessage={(result) =>
        result.changed
          ? `Person ${result.status === "disabled" ? "disabled" : "enabled"}`
          : { neutral: `The person was already ${result.status}` }
      }
      title={
        <>
          {copy.action} <Code>{principalId}</Code>
        </>
      }
    >
      <ReasonField onChange={setReason} reason={reason} />
    </ActionDialog>
  );
}
