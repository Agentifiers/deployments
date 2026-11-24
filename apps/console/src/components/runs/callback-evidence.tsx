import { useQuery } from "@tanstack/react-query";
import { callbackEvidenceQuery } from "../../data/thread-queries.ts";
import type { EnvironmentScope } from "../../scope.ts";
import type { CallbackEvidence } from "../../server/callback-evidence-data.ts";
import { Button } from "@/components/ui/button";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Code, Text } from "@/components/ui/text";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { describeProblem } from "../section-boundary.tsx";

function EvidenceFields({ evidence }: Readonly<{ evidence: CallbackEvidence }>) {
  return (
    <DescriptionList>
      <DescriptionTerm>Tool</DescriptionTerm>
      <DescriptionDetails>
        <Code>{evidence.toolName}</Code>
      </DescriptionDetails>
      <DescriptionTerm>Effect</DescriptionTerm>
      <DescriptionDetails>{evidence.effect}</DescriptionDetails>
      <DescriptionTerm>Policy</DescriptionTerm>
      <DescriptionDetails>
        {evidence.policyAction} · {evidence.policyReason}
      </DescriptionDetails>
      <DescriptionTerm>Scopes</DescriptionTerm>
      <DescriptionDetails>
        {evidence.requiredScopes.length === 0 ? "—" : evidence.requiredScopes.join(", ")}
      </DescriptionDetails>
      {evidence.approval ? (
        <>
          <DescriptionTerm>Approval</DescriptionTerm>
          <DescriptionDetails>
            <PublicId value={evidence.approval.id} /> approved
            {evidence.approval.resolvedBy ? ` by ${evidence.approval.resolvedBy.type}` : ""}
          </DescriptionDetails>
        </>
      ) : null}
      <DescriptionTerm>Input hash</DescriptionTerm>
      <DescriptionDetails>
        <Code title={evidence.inputHash}>{evidence.inputHash.slice(0, 16)}…</Code>
      </DescriptionDetails>
      <DescriptionTerm>Idempotency key</DescriptionTerm>
      <DescriptionDetails>
        <Code>{evidence.idempotencyKey}</Code>
      </DescriptionDetails>
      <DescriptionTerm>Recorded</DescriptionTerm>
      <DescriptionDetails>
        <Timestamp value={evidence.createdAt} />
      </DescriptionDetails>
    </DescriptionList>
  );
}

/**
 * What the platform authorized before an HTTP callback tool call left it: the policy, scopes,
 * approval, and input hash a receiver can check against `callbackEvidenceId`.
 */
export function CallbackEvidenceDialog({
  onClose,
  scope,
  toolCallId,
}: Readonly<{ onClose: () => void; scope: EnvironmentScope; toolCallId: string }>) {
  const evidence = useQuery(callbackEvidenceQuery(scope, toolCallId));
  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Callback authorization</DialogTitle>
          <DialogDescription>
            Recorded before the call left the platform. The receiver gets its ID as{" "}
            <Code>callbackEvidenceId</Code>.
          </DialogDescription>
        </DialogHeader>
        {evidence.isPending ? (
          <Text>Loading…</Text>
        ) : evidence.isError ? (
          <Text className="text-destructive">
            {describeProblem(evidence.error, "The evidence did not load").title}
          </Text>
        ) : evidence.data === null ? (
          <Text>This tool call sent no HTTP callback, so the platform recorded no evidence.</Text>
        ) : (
          <EvidenceFields evidence={evidence.data} />
        )}
        <DialogFooter>
          <Button onClick={onClose} variant="ghost">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
