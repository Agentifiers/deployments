import type { IdentityProviderResponse } from "@deployments-ai/api-contract";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  deleteIdentityProviderFn,
  putIdentityProviderFn,
  setIdentityProviderStateFn,
} from "../../data/sign-in-mutations.ts";
import {
  identityProviderLinksQuery,
  invalidateSignIn,
  samlServiceProviderQuery,
} from "../../data/sign-in-queries.ts";
import { oneOf } from "../../observability/range.ts";
import {
  JIT_CHOICES,
  MOVE_REQUESTS,
  PROTOCOLS,
  protocolSwitchWarning,
  providerForm,
  providerRequest,
  type LinkedAccounts,
  type Protocol,
  type ProviderForm,
  type ProviderMove,
} from "../../sign-in/identity-provider.ts";
import { Callout, CalloutDescription } from "@/components/ui/callout";
import { Description, Field, Fieldset, Label, Legend, RadioField } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Text } from "@/components/ui/text";
import { ActionDialog, refreshOnConflict } from "../action-dialog.tsx";
import { SamlProviderFields } from "./saml-provider-fields.tsx";

const PROTOCOL_COPY: {
  readonly [Value in Protocol]: {
    readonly description: string;
    readonly label: string;
    readonly onSave: string;
  };
} = {
  oidc: {
    description: "Sign in through an OAuth client registered with the identity provider.",
    label: "OpenID Connect",
    onSave: "The platform reads the issuer's OpenID configuration when you save.",
  },
  saml: {
    description: "Sign in through a SAML application, configured from its metadata.",
    label: "SAML 2.0",
    onSave:
      "The platform reads the metadata when you save. After the identity provider rotates its signing certificate, save again from the metadata URL to keep the connection. Pasted metadata with new certificates starts a new connection, and every member links again.",
  },
};

const JIT_LABELS: Readonly<Record<(typeof JIT_CHOICES)[number], string>> = {
  member: "On: a first sign-in joins as member",
  off: "Off: only existing members sign in",
  viewer: "On: a first sign-in joins as viewer",
};

const MOVE_COPY: {
  readonly [Move in ProviderMove]: {
    readonly confirmLabel: string;
    readonly description: string;
    readonly success: string;
  };
} = {
  disable: {
    confirmLabel: "Disable",
    description: "Members stop signing in through this identity provider. Settings and links stay.",
    success: "Identity provider disabled",
  },
  enable: {
    confirmLabel: "Enable",
    description: "Members on verified domains sign in through this identity provider again.",
    success: "Identity provider enabled",
  },
  "make-optional": {
    confirmLabel: "Make optional",
    description: "Members may sign in without the identity provider again.",
    success: "Sign-in through the identity provider is optional",
  },
  require: {
    confirmLabel: "Require",
    description:
      "Members on verified domains must sign in through this identity provider. This needs your own current session to come from this identity provider; if it does not, sign out and sign in again with your work email first. Owners can still sign in without it.",
    success: "Sign-in through the identity provider is required",
  },
};

interface DialogProps {
  readonly onClose: () => void;
  readonly organizationId: string;
}

export function ProviderSettingsDialog({
  current,
  linksVisible,
  onClose,
  organizationId,
}: DialogProps & {
  readonly current: IdentityProviderResponse | null;
  readonly linksVisible: boolean;
}) {
  const queryClient = useQueryClient();
  const [initial] = useState<ProviderForm>(() => providerForm(current));
  const [form, setForm] = useState(initial);
  const update = (patch: Partial<ProviderForm>) =>
    setForm((previous) => ({ ...previous, ...patch }));
  const request = providerRequest(form, current);
  const links = useInfiniteQuery({
    ...identityProviderLinksQuery(organizationId),
    enabled: linksVisible && current !== null,
  });
  const linked: LinkedAccounts = links.data
    ? {
        count: links.data.pages.reduce((count, page) => count + page.items.length, 0),
        kind: "counted",
        more: links.hasNextPage,
      }
    : { kind: "unknown" };
  const warning = protocolSwitchWarning(current, form.protocol, linked);
  const derivedServiceProvider = useQuery({
    ...samlServiceProviderQuery(organizationId),
    enabled: form.protocol === "saml" && current?.protocol !== "saml",
  });
  const edit = (field: "clientId" | "displayName" | "issuer" | "newClientSecret") => ({
    onChange: (event: { readonly target: { readonly value: string } }) =>
      update({ [field]: event.target.value }),
    value: form[field],
  });
  return (
    <ActionDialog
      confirmLabel={current === null ? "Set up" : "Save changes"}
      description={PROTOCOL_COPY[form.protocol].onSave}
      invalid={request.kind === "incomplete"}
      onClose={onClose}
      onSuccess={() => void invalidateSignIn(queryClient, organizationId)}
      open
      run={(idempotencyKey) => {
        if (request.kind === "incomplete") throw new TypeError(request.reason);
        return refreshOnConflict(
          putIdentityProviderFn({
            data: {
              body: request.body,
              idempotencyKey,
              scope: { organizationId },
            },
          }),
          () => invalidateSignIn(queryClient, organizationId),
        );
      }}
      size="xl"
      successMessage="Identity provider saved"
      title={current === null ? "Set up an identity provider" : "Identity provider settings"}
    >
      <Fieldset>
        <Legend>Protocol</Legend>
        <RadioGroup
          className="mt-3"
          onValueChange={(value: string) => {
            const protocol = oneOf(PROTOCOLS, value);
            if (protocol) update({ protocol });
          }}
          value={form.protocol}
        >
          {PROTOCOLS.map((protocol) => (
            <RadioField key={protocol}>
              <RadioGroupItem value={protocol} />
              <Label>{PROTOCOL_COPY[protocol].label}</Label>
              <Description>{PROTOCOL_COPY[protocol].description}</Description>
            </RadioField>
          ))}
        </RadioGroup>
      </Fieldset>
      <Field>
        <Label>Display name</Label>
        <Description>Shown on the sign-in page.</Description>
        <Input autoComplete="off" {...edit("displayName")} />
      </Field>
      {form.protocol === "oidc" ? (
        <>
          <Field>
            <Label>Issuer</Label>
            <Description>
              The OpenID Connect issuer URL, such as https://login.example.com.
            </Description>
            <Input autoComplete="off" className="font-mono" {...edit("issuer")} />
          </Field>
          <Field>
            <Label>Client ID</Label>
            <Input autoComplete="off" className="font-mono" {...edit("clientId")} />
          </Field>
          <Field>
            <Label>Client secret</Label>
            <Description>
              {current?.protocol === "oidc"
                ? "Leave blank to keep the stored secret. Required when the issuer or client ID changes."
                : "Stored encrypted and never shown again."}
            </Description>
            <Input autoComplete="off" type="password" {...edit("newClientSecret")} />
          </Field>
        </>
      ) : (
        <SamlProviderFields
          form={form}
          serviceProvider={
            current?.protocol === "saml" ? current.serviceProvider : derivedServiceProvider.data
          }
          update={update}
        />
      )}
      <Field>
        <Label>Just-in-time membership</Label>
        <NativeSelect
          name="jit"
          onChange={(event) => {
            const jit = oneOf(JIT_CHOICES, event.target.value);
            if (jit) update({ jit });
          }}
          value={form.jit}
        >
          {JIT_CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {JIT_LABELS[choice]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {warning ? (
        <Callout variant="warning">
          <CalloutDescription>{warning}</CalloutDescription>
        </Callout>
      ) : null}
      {request.kind === "incomplete" && (current !== null || form !== initial) ? (
        <Text>{request.reason}</Text>
      ) : null}
    </ActionDialog>
  );
}

export function ProviderStateDialog({
  move,
  onClose,
  organizationId,
  provider,
}: DialogProps & { readonly move: ProviderMove; readonly provider: IdentityProviderResponse }) {
  const queryClient = useQueryClient();
  const copy = MOVE_COPY[move];
  return (
    <ActionDialog
      confirmLabel={copy.confirmLabel}
      confirmation={move === "disable" || move === "require" ? provider.displayName : undefined}
      description={copy.description}
      destructive={move === "disable"}
      onClose={onClose}
      onSuccess={() => void invalidateSignIn(queryClient, organizationId)}
      open
      run={(idempotencyKey) =>
        refreshOnConflict(
          setIdentityProviderStateFn({
            data: { body: MOVE_REQUESTS[move], idempotencyKey, scope: { organizationId } },
          }),
          () => invalidateSignIn(queryClient, organizationId),
        )
      }
      successMessage={copy.success}
      title={`${copy.confirmLabel}: ${provider.displayName}`}
    />
  );
}

export function DeleteProviderDialog({
  onClose,
  organizationId,
  provider,
}: DialogProps & { readonly provider: IdentityProviderResponse }) {
  const queryClient = useQueryClient();
  return (
    <ActionDialog
      confirmLabel="Delete identity provider"
      confirmation={provider.displayName}
      description="Deletes the settings and any stored client secret. Members sign in without it."
      destructive
      onClose={onClose}
      onSuccess={() => void invalidateSignIn(queryClient, organizationId)}
      open
      run={(idempotencyKey) =>
        refreshOnConflict(
          deleteIdentityProviderFn({ data: { idempotencyKey, scope: { organizationId } } }),
          () => invalidateSignIn(queryClient, organizationId),
        )
      }
      successMessage="Identity provider deleted"
      title={`Delete ${provider.displayName}?`}
    />
  );
}
