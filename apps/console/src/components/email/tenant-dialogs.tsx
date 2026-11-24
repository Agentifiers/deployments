import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { environmentQuery } from "../../data/console-queries.ts";
import {
  createTenantDomainFn,
  createTenantFn,
  sendTenantEmailFn,
  updateTenantFn,
} from "../../data/email-tenant-mutations.ts";
import { DOMAIN_NAME } from "../../email/addresses.ts";
import { invalidateEmailTenants } from "../../data/email-tenant-queries.ts";
import {
  readSendDraft,
  TENANT_STATUS_CHANGE,
  type EmailDomain,
  type EmailTenant,
  type SendDraft,
} from "../../email/tenant-state.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Description, Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";

interface DialogProps {
  readonly onClose: () => void;
  readonly open: boolean;
  readonly scope: EnvironmentScope;
}

const NAME = /^.{1,120}$/u;

export function CreateTenantDialog({ onClose, open, scope }: DialogProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [name, setName] = useState("");
  useEffect(() => {
    if (open) setName("");
  }, [open]);
  const value = name.trim();
  return (
    <ActionDialog<EmailTenant>
      confirmLabel="Create tenant"
      confirmation={typedConfirmation(environment.type, { phrase: value || "create" })}
      description="Creating a tenant provisions an SES tenant with its own configuration set right away."
      invalid={!NAME.test(value)}
      onClose={onClose}
      onSuccess={(tenant) => {
        void invalidateEmailTenants(queryClient, scope);
        void navigate({
          params: {
            envId: scope.environmentId,
            orgId: scope.organizationId,
            projectId: scope.projectId,
            tenantId: tenant.id,
          },
          to: "/o/$orgId/p/$projectId/e/$envId/email/tenants/$tenantId",
        });
      }}
      open={open}
      run={(idempotencyKey) =>
        createTenantFn({ data: { body: { name: value }, idempotencyKey, scope } })
      }
      successMessage={(tenant) => `Created ${tenant.name}`}
      title="Create sending tenant"
    >
      <Field>
        <Label>Name</Label>
        <Input autoComplete="off" onChange={(event) => setName(event.target.value)} value={name} />
      </Field>
    </ActionDialog>
  );
}

export function TenantStatusDialog({
  onClose,
  open,
  scope,
  tenant,
}: DialogProps & { readonly tenant: EmailTenant }) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const change = TENANT_STATUS_CHANGE[tenant.status];
  const pausing = change.next === "paused";
  return (
    <ActionDialog
      confirmLabel={change.label}
      confirmation={typedConfirmation(environment.type, {
        destructive: pausing,
        phrase: tenant.name,
      })}
      description={
        pausing
          ? "A paused tenant refuses every send with email_tenant_paused until it resumes."
          : "The tenant accepts sends again."
      }
      destructive={pausing}
      onClose={onClose}
      onSuccess={() => void invalidateEmailTenants(queryClient, scope)}
      open={open}
      run={(idempotencyKey) =>
        updateTenantFn({
          data: { body: { status: change.next }, idempotencyKey, scope, tenantId: tenant.id },
        })
      }
      successMessage={(updated) => `${updated.name} is ${updated.status}`}
      title={`${change.label}: ${tenant.name}`}
    />
  );
}

export function CreateTenantDomainDialog({
  onClose,
  open,
  scope,
  tenant,
}: DialogProps & { readonly tenant: EmailTenant }) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [domain, setDomain] = useState("");
  useEffect(() => {
    if (open) setDomain("");
  }, [open]);
  const value = domain.trim().toLowerCase();
  return (
    <ActionDialog
      confirmLabel="Add domain"
      confirmation={typedConfirmation(environment.type, { phrase: value || "create" })}
      description="Send-only: publish the ownership TXT record, then refresh to create the sending identity and list its DKIM and MAIL FROM records."
      invalid={!DOMAIN_NAME.test(value)}
      onClose={onClose}
      onSuccess={() => void invalidateEmailTenants(queryClient, scope)}
      open={open}
      run={(idempotencyKey) =>
        createTenantDomainFn({
          data: { body: { domain: value }, idempotencyKey, scope, tenantId: tenant.id },
        })
      }
      successMessage={(created) => `Added ${created.domain}`}
      title={`Add a domain to ${tenant.name}`}
    >
      <Field>
        <Label>Domain</Label>
        <Input
          autoComplete="off"
          onChange={(event) => setDomain(event.target.value)}
          placeholder="notify.example.com"
          value={domain}
        />
      </Field>
    </ActionDialog>
  );
}

const EMPTY_SEND: SendDraft = {
  bcc: "",
  cc: "",
  domain: "",
  localPart: "",
  subject: "",
  text: "",
  to: "",
};

export function SendTenantEmailDialog({
  domains,
  onClose,
  open,
  scope,
  tenant,
}: DialogProps & { readonly domains: readonly EmailDomain[]; readonly tenant: EmailTenant }) {
  const [draft, setDraft] = useState(EMPTY_SEND);
  useEffect(() => {
    if (open) setDraft(EMPTY_SEND);
  }, [open]);
  const read = readSendDraft(draft);
  const verified = domains.filter((domain) => domain.status === "verified");
  return (
    <ActionDialog
      confirmLabel="Send"
      confirmation="send"
      description="Real mail leaves through the tenant's SES configuration. The platform keeps no copy."
      invalid={!read.ok}
      onClose={onClose}
      open={open}
      retryNotice="The send may have reached the provider. Do not send again until you know it did not: the platform never retries after an unknown outcome."
      run={(idempotencyKey) =>
        sendTenantEmailFn({
          data: {
            body: read.ok ? read.body : { from: "", subject: "", to: [] },
            idempotencyKey,
            scope,
            tenantId: tenant.id,
          },
        })
      }
      size="2xl"
      successMessage={(sent) => `Accepted: ${sent.providerMessageId}`}
      title={`Send from ${tenant.name}`}
    >
      <div className="grid gap-6 sm:grid-cols-2">
        <Field>
          <Label>From</Label>
          <Input
            autoComplete="off"
            onChange={(event) => setDraft({ ...draft, localPart: event.target.value })}
            placeholder="notices"
            value={draft.localPart}
          />
        </Field>
        <Field>
          <Label>Domain</Label>
          <NativeSelect
            onChange={(event) => setDraft({ ...draft, domain: event.target.value })}
            value={draft.domain}
          >
            <option value="">
              {verified.length === 0 ? "No verified domain" : "Choose a domain"}
            </option>
            {verified.map((domain) => (
              <option key={domain.id} value={domain.domain}>
                @{domain.domain}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      {(["to", "cc", "bcc"] as const).map((field) => (
        <Field key={field}>
          <Label>{field === "to" ? "To" : field === "cc" ? "Cc" : "Bcc"}</Label>
          {field === "to" ? (
            <Description>Separate addresses with commas. At most 50 recipients in all.</Description>
          ) : null}
          <Input
            autoComplete="off"
            onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
            value={draft[field]}
          />
        </Field>
      ))}
      <Field>
        <Label>Subject</Label>
        <Input
          autoComplete="off"
          onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
          value={draft.subject}
        />
      </Field>
      <Field>
        <Label>Body</Label>
        <Textarea
          onChange={(event) => setDraft({ ...draft, text: event.target.value })}
          rows={6}
          value={draft.text}
        />
      </Field>
      {read.ok ? null : <Text>{read.message}</Text>}
    </ActionDialog>
  );
}
