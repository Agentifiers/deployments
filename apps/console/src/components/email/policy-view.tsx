import { PauseIcon, PencilEdit02Icon, PlayIcon } from "@hugeicons/core-free-icons";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { environmentQuery, organizationShellQuery } from "../../data/console-queries.ts";
import { updatePolicyFn } from "../../data/agent-email-setup-mutations.ts";
import { invalidateAgentEmail, policyQuery } from "../../data/agent-email-setup-queries.ts";
import {
  POLICY_LIMITS,
  POLICY_NUMBERS,
  policyChanges,
  policyDraft,
  type PolicyDraft,
} from "../../email/policy-state.ts";
import { WARMUP_STAGES, type PolicyState } from "../../email/setup-state.ts";
import { oneOf } from "../../observability/range.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { statusColor } from "../../status.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Description, Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";
import { Icon } from "../icon.tsx";
import { Timestamp } from "../observability/panels.tsx";

const NUMBER_HINTS: Readonly<Record<(typeof POLICY_NUMBERS)[number], string>> = {
  bounceRateThresholdBasisPoints: "Basis points: 100 is 1%.",
  complaintRateThresholdBasisPoints: "Basis points: 100 is 1%.",
  dailyOutboundMessageLimit: "The warmup stage may cap it lower.",
  maxAttachmentBytes: "Bytes, at most 4 MiB (4194304).",
  maxRecipientsPerMessage: "1 to 47.",
  rawRetentionDays: "1 to 365 days.",
};

type Dialog = "edit" | "pause" | "resume";

export function PolicyView({ scope }: Readonly<{ scope: EnvironmentScope }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: state } = useSuspenseQuery(policyQuery(scope));
  const [dialog, setDialog] = useState<Dialog>();
  const canEdit = shell.access.updateAgentEmailPolicy;
  const sending = state.kind === "saved" ? state.policy.sendingStatus : "active";
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Badge color={statusColor(sending)}>
          {sending === "active" ? "Sending allowed" : "Sending paused"}
        </Badge>
        {canEdit ? (
          <div className="ml-auto flex flex-wrap gap-3">
            <Button onClick={() => setDialog("edit")} variant="outline">
              <Icon icon={PencilEdit02Icon} />
              Edit policy
            </Button>
            {sending === "active" ? (
              <Button variant="destructive" onClick={() => setDialog("pause")}>
                <Icon icon={PauseIcon} />
                Pause sending
              </Button>
            ) : (
              <Button onClick={() => setDialog("resume")}>
                <Icon icon={PlayIcon} />
                Resume sending
              </Button>
            )}
          </div>
        ) : null}
      </div>
      {state.kind === "defaults" ? (
        <Text>
          No policy is saved for this environment, so the platform defaults apply. The first send or
          edit saves them.
        </Text>
      ) : (
        <PolicyFacts state={state} />
      )}
      {canEdit ? (
        <>
          <EditPolicyDialog
            onClose={() => setDialog(undefined)}
            open={dialog === "edit"}
            scope={scope}
            state={state}
          />
          <SendingDialog
            onClose={() => setDialog(undefined)}
            pause={dialog === "pause"}
            open={dialog === "pause" || dialog === "resume"}
            scope={scope}
          />
        </>
      ) : null}
    </div>
  );
}

function PolicyFacts({ state }: Readonly<{ state: Extract<PolicyState, { kind: "saved" }> }>) {
  const { policy } = state;
  return (
    <DescriptionList>
      {policy.sendingStatusReason ? (
        <>
          <DescriptionTerm>Sending status reason</DescriptionTerm>
          <DescriptionDetails>{policy.sendingStatusReason}</DescriptionDetails>
        </>
      ) : null}
      <DescriptionTerm>Warmup stage</DescriptionTerm>
      <DescriptionDetails>
        {policy.warmupStage}
        {policy.warmupStartedAt ? (
          <>
            {" since "}
            <Timestamp value={policy.warmupStartedAt} />
          </>
        ) : null}
      </DescriptionDetails>
      {POLICY_NUMBERS.map((field) => (
        <PolicyNumberFact key={field} label={POLICY_LIMITS[field].label} value={policy[field]} />
      ))}
      <DescriptionTerm>Allowlist</DescriptionTerm>
      <DescriptionDetails>{policy.allowlist?.join(", ") || "None"}</DescriptionDetails>
      <DescriptionTerm>Blocklist</DescriptionTerm>
      <DescriptionDetails>{policy.blocklist?.join(", ") || "None"}</DescriptionDetails>
      <DescriptionTerm>Updated</DescriptionTerm>
      <DescriptionDetails>
        <Timestamp value={policy.updatedAt} />
      </DescriptionDetails>
    </DescriptionList>
  );
}

function PolicyNumberFact({ label, value }: Readonly<{ label: string; value: number }>) {
  return (
    <>
      <DescriptionTerm>{label}</DescriptionTerm>
      <DescriptionDetails className="tabular-nums">{value.toLocaleString()}</DescriptionDetails>
    </>
  );
}

function EditPolicyDialog({
  onClose,
  open,
  scope,
  state,
}: Readonly<{ onClose: () => void; open: boolean; scope: EnvironmentScope; state: PolicyState }>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [draft, setDraft] = useState<PolicyDraft>(() => policyDraft(state));
  useEffect(() => {
    if (open) setDraft(policyDraft(state));
  }, [open, state]);
  const edit = policyChanges(draft, state);
  return (
    <ActionDialog
      confirmLabel="Save policy"
      confirmation={typedConfirmation(environment.type, { phrase: "save" })}
      description={
        state.kind === "defaults"
          ? "Blank fields keep the platform default."
          : "Only changed fields are sent."
      }
      invalid={edit.kind !== "changes"}
      onClose={onClose}
      onSuccess={() => void invalidateAgentEmail(queryClient, scope)}
      open={open}
      run={(idempotencyKey) =>
        updatePolicyFn({
          data: { body: edit.kind === "changes" ? edit.body : {}, idempotencyKey, scope },
        })
      }
      size="2xl"
      successMessage="Policy saved"
      title="Edit sending policy"
    >
      <Field>
        <Label>Warmup stage</Label>
        <Description>
          Sandbox and ramp_1 send only to own inboxes, allowlisted, or verified recipients.
        </Description>
        <NativeSelect
          onChange={(event) =>
            setDraft({ ...draft, warmupStage: oneOf(WARMUP_STAGES, event.target.value) ?? "" })
          }
          value={draft.warmupStage}
        >
          {state.kind === "defaults" ? <option value="">Platform default</option> : null}
          {WARMUP_STAGES.map((stage) => (
            <option key={stage} value={stage}>
              {stage}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <div className="grid gap-6 sm:grid-cols-2">
        {POLICY_NUMBERS.map((field) => (
          <Field key={field}>
            <Label>{POLICY_LIMITS[field].label}</Label>
            <Description>{NUMBER_HINTS[field]}</Description>
            <Input
              inputMode="numeric"
              onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
              placeholder={state.kind === "defaults" ? "Platform default" : undefined}
              value={draft[field]}
            />
          </Field>
        ))}
      </div>
      {(["allowlist", "blocklist"] as const).map((field) => (
        <Field key={field}>
          <Label>{field === "allowlist" ? "Allowlist" : "Blocklist"}</Label>
          <Description>
            {field === "allowlist"
              ? "Recipients that count as verified during warmup. Up to 50 addresses."
              : "Recipients every send refuses. Up to 50 addresses."}
          </Description>
          <Textarea
            className="font-mono"
            onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
            rows={3}
            value={draft[field]}
          />
        </Field>
      ))}
      {edit.kind === "invalid" ? <Text>{edit.message}</Text> : null}
    </ActionDialog>
  );
}

function SendingDialog({
  onClose,
  open,
  pause,
  scope,
}: Readonly<{ onClose: () => void; open: boolean; pause: boolean; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  return (
    <ActionDialog
      confirmLabel={pause ? "Pause sending" : "Resume sending"}
      confirmation={typedConfirmation(environment.type, {
        destructive: pause,
        phrase: pause ? "pause" : "resume",
      })}
      description={
        pause
          ? "Every send, reply, forward, and draft send in this environment fails with email_sending_paused until sending resumes. Inbound mail still arrives."
          : "Outbound mail is accepted again under the current policy."
      }
      destructive={pause}
      onClose={onClose}
      onSuccess={() => void invalidateAgentEmail(queryClient, scope)}
      open={open}
      run={(idempotencyKey) =>
        updatePolicyFn({
          data: { body: { sendingStatus: pause ? "paused" : "active" }, idempotencyKey, scope },
        })
      }
      successMessage={pause ? "Sending paused" : "Sending resumed"}
      title={pause ? "Pause outbound email" : "Resume outbound email"}
    />
  );
}
