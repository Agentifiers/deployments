import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  resendPrincipalVerificationFn,
  revokePrincipalSessionsFn,
} from "../../data/system-mutations.ts";
import { invalidatePerson } from "../../data/system-queries.ts";
import { Description, ErrorMessage, Field, Label } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Code } from "@/components/ui/text";
import { ActionDialog } from "../action-dialog.tsx";

/** Why a reason cannot be sent yet, matching the contract's non-blank, 500-character rule. */
export function reasonProblem(reason: string): string | undefined {
  if (reason.trim() === "") return "Required";
  return reason.length > 500 ? "At most 500 characters" : undefined;
}

export function ReasonField({
  onChange,
  reason,
}: Readonly<{ onChange: (reason: string) => void; reason: string }>) {
  const problem = reasonProblem(reason);
  return (
    <Field>
      <Label>Reason</Label>
      <Textarea
        name="reason"
        onChange={(event) => onChange(event.target.value)}
        rows={2}
        value={reason}
      />
      <Description>Recorded in the person's security events.</Description>
      {reason !== "" && problem ? <ErrorMessage>{problem}</ErrorMessage> : null}
    </Field>
  );
}

/** The phrase to type before ending a person's sessions: the ID's tail, so a wrong page does not confirm. */
export function revokeConfirmation(principalId: string): string {
  return `revoke ${principalId.slice(-8)}`;
}

export function RevokeSessionsDialog({
  onClose,
  principalId,
}: Readonly<{ onClose: () => void; principalId: string }>) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  return (
    <ActionDialog
      confirmLabel="End sessions"
      confirmation={revokeConfirmation(principalId)}
      description="Ends every browser session, app session, refresh token, and device grant the person holds at once, without disabling them. Access tokens already issued stop working within 10 minutes. They sign in again to continue. Ending sessions again later is safe."
      destructive
      invalid={reasonProblem(reason) !== undefined}
      onClose={onClose}
      onSuccess={() => void invalidatePerson(queryClient, principalId)}
      open
      runOnce={() =>
        revokePrincipalSessionsFn({ data: { body: { reason: reason.trim() }, principalId } })
      }
      size="xl"
      successMessage="Sessions ended"
      title={
        <>
          End sessions for <Code>{principalId}</Code>
        </>
      }
    >
      <ReasonField onChange={setReason} reason={reason} />
    </ActionDialog>
  );
}

/** Resends the verification email a pending sign-up waits on, under the self-service limits. */
export function ResendVerificationDialog({
  email,
  onClose,
  principalId,
}: Readonly<{ email: string; onClose: () => void; principalId: string }>) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  return (
    <ActionDialog
      confirmLabel="Send email"
      description="Sends a fresh verification link through the install's identity email outbox and extends the sign-up. The person's own limits apply: one email a minute and three an hour."
      invalid={reasonProblem(reason) !== undefined}
      onClose={onClose}
      onSuccess={() =>
        void queryClient.invalidateQueries({ queryKey: ["system", "person-by-email"] })
      }
      open
      runOnce={() =>
        resendPrincipalVerificationFn({
          data: { body: { email, reason: reason.trim() }, principalId },
        })
      }
      size="xl"
      successMessage={(result) => `Verification email sent to ${result.email}`}
      title={
        <>
          Resend verification to <Code>{email}</Code>
        </>
      }
    >
      <ReasonField onChange={setReason} reason={reason} />
    </ActionDialog>
  );
}
