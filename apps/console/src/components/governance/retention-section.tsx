import { PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { invalidateGovernance, retentionPolicyQuery } from "../../data/governance-queries.ts";
import { updateRetentionPolicyFn } from "../../data/governance-mutations.ts";
import {
  planRetention,
  rebaseRetentionDraft,
  RETENTION_CLASSES,
  retentionDraft,
  type RetentionDraft,
  type RetentionPolicy,
} from "../../governance/retention-state.ts";
import { Button } from "@/components/ui/button";
import { Description, ErrorMessage, Field, Label } from "@/components/ui/field";
import { Subheading } from "@/components/ui/heading";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/reui/number-field";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Text } from "@/components/ui/text";
import { ActionDialog, refreshOnConflict } from "../action-dialog.tsx";
import { Icon } from "../icon.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";

export function RetentionSection({
  canEdit,
  organizationId,
  organizationSlug,
}: Readonly<{ canEdit: boolean; organizationId: string; organizationSlug: string }>) {
  const { data: policy } = useSuspenseQuery(retentionPolicyQuery(organizationId));
  const [editing, setEditing] = useState(false);
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Subheading>Retention</Subheading>
        {canEdit ? (
          <Button className="ml-auto" onClick={() => setEditing(true)} variant="outline">
            <Icon icon={PencilEdit02Icon} />
            Edit retention
          </Button>
        ) : null}
      </div>
      <Text>
        A daily sweep deletes records older than their class&apos;s retention. Records still in use,
        such as active runs, are kept.{" "}
        {policy.version === 0 ? (
          "These are the platform defaults; nobody has changed them."
        ) : (
          <>
            Version {policy.version}, last changed <Timestamp value={policy.updatedAt} /> by{" "}
            <PublicId value={policy.updatedByPrincipalId} />.
          </>
        )}
      </Text>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Class</TableHead>
            <TableHead>Covers</TableHead>
            <TableHead className="text-right">Days kept</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {RETENTION_CLASSES.map(({ covers, field }) => (
            <TableRow key={field}>
              <TableCell className="font-medium capitalize">{field}</TableCell>
              <TableCell className="text-muted-foreground">{covers}</TableCell>
              <TableCell className="text-right tabular-nums">{policy[field]}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <RetentionDialog
        onClose={() => setEditing(false)}
        open={editing}
        organizationSlug={organizationSlug}
        policy={policy}
      />
    </section>
  );
}

function RetentionDialog({
  onClose,
  open,
  organizationSlug,
  policy,
}: Readonly<{
  onClose: () => void;
  open: boolean;
  organizationSlug: string;
  policy: RetentionPolicy;
}>) {
  const queryClient = useQueryClient();
  const [base, setBase] = useState(policy);
  const [draft, setDraft] = useState<RetentionDraft>(() => retentionDraft(policy));
  useEffect(() => {
    if (!open) return;
    setBase(policy);
    setDraft(retentionDraft(policy));
  }, [open]);
  // A 409 refetches the policy under the open dialog; the next save must compare against it.
  if (base.version !== policy.version) {
    setBase(policy);
    setDraft(rebaseRetentionDraft(draft, base, policy));
  }
  const plan = planRetention(draft, base);
  const issues = plan.kind === "invalid" ? plan.issues : [];
  const shortened = plan.kind === "change" ? plan.shortened : [];
  return (
    <ActionDialog
      confirmLabel="Save retention"
      confirmation={shortened.length > 0 ? organizationSlug : undefined}
      description="Shorter retention takes effect at the next daily sweep, which deletes records older than the new limit. Deleted records cannot be restored."
      invalid={plan.kind !== "change"}
      onClose={onClose}
      onSuccess={() => void invalidateGovernance(queryClient, policy.organizationId)}
      open={open}
      run={(idempotencyKey) =>
        refreshOnConflict(
          updateRetentionPolicyFn({
            data: {
              body: plan.kind === "change" ? plan.patch : {},
              expectedVersion: base.version,
              idempotencyKey,
              scope: { organizationId: policy.organizationId },
            },
          }),
          () => invalidateGovernance(queryClient, policy.organizationId),
        )
      }
      size="2xl"
      successMessage="Retention saved"
      title="Edit retention"
    >
      <div className="grid gap-6 sm:grid-cols-2">
        {RETENTION_CLASSES.map(({ field, maxDays, minDays }) => {
          const issue = issues.find((candidate) => candidate.field === field)?.message;
          const typed = draft[field].trim() === "" ? Number.NaN : Number(draft[field]);
          const setText = (text: string) => setDraft({ ...draft, [field]: text });
          return (
            <Field key={field}>
              <Label className="capitalize">{field}</Label>
              <Description>
                {minDays} to {maxDays} days
              </Description>
              <NumberField
                allowOutOfRange
                format={{ useGrouping: false }}
                max={maxDays}
                min={minDays}
                name={field}
                onValueChange={(next) => setText(next === null ? "" : String(next))}
                value={Number.isFinite(typed) ? typed : null}
              >
                <NumberFieldGroup className="has-aria-invalid:border-destructive has-aria-invalid:ring-3 has-aria-invalid:ring-destructive/20 dark:has-aria-invalid:ring-destructive/40">
                  <NumberFieldDecrement />
                  <NumberFieldInput
                    aria-invalid={issue !== undefined}
                    onChange={(event) => setText(event.currentTarget.value)}
                  />
                  <NumberFieldIncrement />
                </NumberFieldGroup>
              </NumberField>
              {issue ? <ErrorMessage>{issue}</ErrorMessage> : null}
            </Field>
          );
        })}
      </div>
      {shortened.length > 0 ? (
        <Text>
          Shortening {shortened.join(", ")} deletes older records at the next sweep. Type the
          organization slug to confirm.
        </Text>
      ) : null}
    </ActionDialog>
  );
}
