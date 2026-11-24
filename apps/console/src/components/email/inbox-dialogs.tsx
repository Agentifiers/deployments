import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { environmentQuery } from "../../data/console-queries.ts";
import { useInstallCopy } from "../../edition.ts";
import {
  createBindingFn,
  createInboxFn,
  deleteBindingFn,
  updateInboxFn,
} from "../../data/agent-email-inbox-mutations.ts";
import { deploymentTargetsQuery } from "../../data/agent-email-inbox-queries.ts";
import {
  invalidateAgentEmail,
  verifiedDomainsQuery,
} from "../../data/agent-email-setup-queries.ts";
import {
  INBOX_STATUS_AFTER,
  readBindingDraft,
  readInboxDraft,
  type AgentEmailBinding,
  type AgentEmailInbox,
  type BindingDraft,
  type InboxAction,
  type InboxDraft,
} from "../../email/inbox-state.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Description, Field, Label, RadioField } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Code, Text } from "@/components/ui/text";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";

interface DialogProps {
  readonly onClose: () => void;
  readonly open: boolean;
  readonly scope: EnvironmentScope;
}

const EMPTY_INBOX: InboxDraft = { domainId: "", localPart: "", name: "" };

export function CreateInboxDialog({ onClose, open, scope }: DialogProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const domains = useQuery({ ...verifiedDomainsQuery(scope), enabled: open });
  const [draft, setDraft] = useState(EMPTY_INBOX);
  const { hostedEmailDomain } = useInstallCopy();
  useEffect(() => {
    if (open) setDraft(EMPTY_INBOX);
  }, [open]);
  const read = readInboxDraft(draft);
  const domain = domains.data?.find((entry) => entry.id === draft.domainId);
  return (
    <ActionDialog<AgentEmailInbox>
      confirmLabel="Create inbox"
      confirmation={typedConfirmation(environment.type, {
        phrase: draft.localPart.trim() || "create",
      })}
      description={`Agents send from and receive at the inbox's address. Without a domain, the inbox uses ${hostedEmailDomain}.`}
      invalid={!read.ok}
      onClose={onClose}
      onSuccess={(inbox) => {
        void invalidateAgentEmail(queryClient, scope);
        void navigate({
          params: {
            envId: scope.environmentId,
            inboxId: inbox.id,
            orgId: scope.organizationId,
            projectId: scope.projectId,
          },
          to: "/o/$orgId/p/$projectId/e/$envId/email/inboxes/$inboxId",
        });
      }}
      open={open}
      run={(idempotencyKey) =>
        createInboxFn({ data: { body: read.ok ? read.body : {}, idempotencyKey, scope } })
      }
      successMessage={(inbox) => `Created ${inbox.address}`}
      title="Create inbox"
    >
      <Field>
        <Label>Name</Label>
        <Input
          autoComplete="off"
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          value={draft.name}
        />
      </Field>
      <Field>
        <Label>Local part</Label>
        <Description>The text before @. Blank uses the inbox ID.</Description>
        <Input
          autoComplete="off"
          aria-invalid={!read.ok}
          onChange={(event) => setDraft({ ...draft, localPart: event.target.value })}
          placeholder="support"
          value={draft.localPart}
        />
      </Field>
      <Field>
        <Label>Domain</Label>
        <NativeSelect
          onChange={(event) => setDraft({ ...draft, domainId: event.target.value })}
          value={draft.domainId}
        >
          <option value="">Hosted domain (default)</option>
          {(domains.data ?? [])
            .filter((entry) => !entry.providerManaged)
            .map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.domain}
              </option>
            ))}
        </NativeSelect>
      </Field>
      {read.ok ? null : <Text>{read.message}</Text>}
      {domain && draft.localPart.trim() ? (
        <Text>
          Address: <Code>{`${draft.localPart.trim().toLowerCase()}@${domain.domain}`}</Code>
        </Text>
      ) : null}
    </ActionDialog>
  );
}

export function RenameInboxDialog({
  inbox,
  onClose,
  open,
  scope,
}: DialogProps & { readonly inbox: AgentEmailInbox }) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [name, setName] = useState(inbox.name ?? "");
  useEffect(() => {
    if (open) setName(inbox.name ?? "");
  }, [inbox.name, open]);
  return (
    <ActionDialog
      confirmLabel="Save changes"
      confirmation={typedConfirmation(environment.type, { phrase: inbox.address })}
      invalid={name.trim().length > 120 || name.trim() === (inbox.name ?? "")}
      onClose={onClose}
      onSuccess={() => void invalidateAgentEmail(queryClient, scope)}
      open={open}
      run={(idempotencyKey) =>
        updateInboxFn({
          data: { body: { name: name.trim() }, idempotencyKey, inboxId: inbox.id, scope },
        })
      }
      successMessage="Inbox renamed"
      title={`Rename ${inbox.address}`}
    >
      <Field>
        <Label>Name</Label>
        <Input autoComplete="off" onChange={(event) => setName(event.target.value)} value={name} />
      </Field>
    </ActionDialog>
  );
}

const STATUS_COPY: Readonly<
  Record<InboxAction, { readonly label: string; readonly description: string }>
> = {
  archive: {
    description:
      "An archived inbox stops sending and receiving, and its bindings no longer start runs.",
    label: "Archive inbox",
  },
  pause: {
    description: "A paused inbox cannot send. Bindings stay in place.",
    label: "Pause inbox",
  },
  resume: {
    description: "The inbox sends again. Its domain must still be verified.",
    label: "Resume inbox",
  },
};

export function InboxStatusDialog({
  action,
  inbox,
  onClose,
  scope,
}: Omit<DialogProps, "open"> & {
  readonly action: InboxAction | undefined;
  readonly inbox: AgentEmailInbox;
}) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const copy = action === undefined ? undefined : STATUS_COPY[action];
  return (
    <ActionDialog
      confirmLabel={copy?.label ?? ""}
      confirmation={typedConfirmation(environment.type, {
        destructive: action === "archive",
        phrase: inbox.address,
      })}
      description={copy?.description}
      destructive={action === "archive"}
      onClose={onClose}
      onSuccess={() => void invalidateAgentEmail(queryClient, scope)}
      open={action !== undefined}
      run={(idempotencyKey) =>
        updateInboxFn({
          data: {
            body: { status: INBOX_STATUS_AFTER[action ?? "pause"] },
            idempotencyKey,
            inboxId: inbox.id,
            scope,
          },
        })
      }
      successMessage={(updated) => `Inbox is ${updated.status}`}
      title={`${copy?.label ?? ""}: ${inbox.address}`}
    />
  );
}

const EMPTY_BINDING: BindingDraft = { agentDeploymentId: "", bindingType: "platform_agent" };

export function CreateBindingDialog({
  inbox,
  onClose,
  open,
  scope,
}: DialogProps & { readonly inbox: AgentEmailInbox }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const targets = useQuery({ ...deploymentTargetsQuery(scope), enabled: open });
  const [draft, setDraft] = useState(EMPTY_BINDING);
  useEffect(() => {
    if (open) setDraft(EMPTY_BINDING);
  }, [open]);
  const body = readBindingDraft(draft);
  return (
    <ActionDialog<AgentEmailBinding>
      confirmLabel="Bind"
      confirmation={typedConfirmation(environment.type, { phrase: inbox.address })}
      description="A platform binding starts a run on the deployment for every message the inbox receives. An agent can hold one active platform binding per environment."
      invalid={body === undefined}
      onClose={onClose}
      onSuccess={(created) => {
        void invalidateAgentEmail(queryClient, scope);
        void navigate({
          params: {
            bindingId: created.id,
            envId: scope.environmentId,
            orgId: scope.organizationId,
            projectId: scope.projectId,
          },
          to: "/o/$orgId/p/$projectId/e/$envId/email/bindings/$bindingId",
        });
      }}
      open={open}
      run={(idempotencyKey) =>
        createBindingFn({ data: { body: body ?? draft, idempotencyKey, inboxId: inbox.id, scope } })
      }
      successMessage="Binding created"
      title={`Bind ${inbox.address}`}
    >
      <RadioGroup
        onValueChange={(bindingType) =>
          setDraft(
            bindingType === "external"
              ? { bindingType: "external", externalId: "" }
              : EMPTY_BINDING,
          )
        }
        value={draft.bindingType}
      >
        <RadioField>
          <RadioGroupItem value="platform_agent" />
          <Label>Agent deployment</Label>
          <Description>Inbound mail starts runs on a deployment in this environment.</Description>
        </RadioField>
        <RadioField>
          <RadioGroupItem value="external" />
          <Label>External system</Label>
          <Description>Records an ID your own system uses to route the inbox's mail.</Description>
        </RadioField>
      </RadioGroup>
      {draft.bindingType === "platform_agent" ? (
        <Field>
          <Label>Deployment</Label>
          <NativeSelect
            disabled={targets.isPending}
            onChange={(event) =>
              setDraft({ agentDeploymentId: event.target.value, bindingType: "platform_agent" })
            }
            value={draft.agentDeploymentId}
          >
            <option value="">
              {targets.isPending
                ? "Loading deployments…"
                : targets.data?.length === 0
                  ? "No running deployments"
                  : "Choose a deployment"}
            </option>
            {(targets.data ?? []).map((target) => (
              <option key={target.id} value={target.id}>
                {target.agentName} · …{target.id.slice(-8)}
              </option>
            ))}
          </NativeSelect>
          <Description>
            Only running deployments are listed. The release must accept the email trigger.
          </Description>
          {targets.error ? <Description>{targets.error.message}</Description> : null}
        </Field>
      ) : (
        <Field>
          <Label>External ID</Label>
          <Input
            autoComplete="off"
            onChange={(event) =>
              setDraft({ bindingType: "external", externalId: event.target.value })
            }
            value={draft.externalId}
          />
        </Field>
      )}
    </ActionDialog>
  );
}

export function ArchiveBindingDialog({
  binding,
  onClose,
  scope,
}: Omit<DialogProps, "open"> & { readonly binding: AgentEmailBinding | undefined }) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  return (
    <ActionDialog
      confirmLabel="Archive binding"
      confirmation={typedConfirmation(environment.type, {
        destructive: true,
        phrase: binding?.id.slice(-8) ?? "",
      })}
      description="Mail the inbox receives afterwards no longer reaches this binding."
      destructive
      onClose={onClose}
      onSuccess={() => void invalidateAgentEmail(queryClient, scope)}
      open={binding !== undefined}
      run={(idempotencyKey) =>
        deleteBindingFn({ data: { bindingId: binding?.id ?? "", idempotencyKey, scope } })
      }
      successMessage="Binding archived"
      title="Archive binding"
    />
  );
}
