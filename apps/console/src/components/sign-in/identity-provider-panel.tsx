import type { IdentityProviderResponse } from "@deployments-ai/api-contract";
import { organizationRoleAllows } from "@deployments-ai/db/organization-role-matrix";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { OperationAccess } from "../../access.ts";
import { identityProviderQuery } from "../../data/sign-in-queries.ts";
import type { ConsoleAuthorization } from "../../permissions.ts";
import { providerMoves, type ProviderMove } from "../../sign-in/identity-provider.ts";
import { statusColor } from "../../status.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Subheading } from "@/components/ui/heading";
import { Code, Text } from "@/components/ui/text";
import { CopyField } from "../copy-field.tsx";
import { Timestamp } from "../observability/panels.tsx";
import {
  DeleteProviderDialog,
  ProviderSettingsDialog,
  ProviderStateDialog,
} from "./provider-dialogs.tsx";
import { ServiceProviderValues } from "./saml-provider-fields.tsx";

type ProviderDialog =
  | { readonly kind: "delete" }
  | { readonly kind: "settings" }
  | { readonly kind: "state"; readonly move: ProviderMove };

const MOVE_LABELS: { readonly [Move in ProviderMove]: string } = {
  disable: "Disable",
  enable: "Enable",
  "make-optional": "Make sign-in optional",
  require: "Require sign-in",
};

export function IdentityProviderPanel({
  access,
  authorization,
  organizationId,
}: Readonly<{
  access: OperationAccess;
  authorization: ConsoleAuthorization;
  organizationId: string;
}>) {
  const { data: provider } = useSuspenseQuery(identityProviderQuery(organizationId));
  const [dialog, setDialog] = useState<ProviderDialog>();
  const close = () => setDialog(undefined);
  const mayEnforce = organizationRoleAllows(authorization.organizationRole, "identity.enforce");
  const moves =
    provider && access.setIdentityProviderState ? providerMoves(provider.state, mayEnforce) : [];
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Subheading>Identity provider</Subheading>
        {provider ? (
          <Badge color={statusColor(provider.state.kind)}>
            {provider.state.kind === "active"
              ? `active, ${provider.state.enforcement}`
              : provider.state.kind}
          </Badge>
        ) : null}
        <div className="ml-auto flex flex-wrap gap-3">
          {access.putIdentityProvider ? (
            <Button onClick={() => setDialog({ kind: "settings" })} variant="outline">
              {provider ? "Edit" : "Set up"}
            </Button>
          ) : null}
          {moves.map((move) =>
            move === "disable" ? (
              <Button
                key={move}
                onClick={() => setDialog({ kind: "state", move })}
                variant="destructive"
              >
                {MOVE_LABELS[move]}
              </Button>
            ) : (
              <Button
                key={move}
                onClick={() => setDialog({ kind: "state", move })}
                variant="outline"
              >
                {MOVE_LABELS[move]}
              </Button>
            ),
          )}
          {provider && access.deleteIdentityProvider ? (
            <Button onClick={() => setDialog({ kind: "delete" })} variant="ghost">
              Delete
            </Button>
          ) : null}
        </div>
      </div>
      {provider === null ? (
        <Text>No identity provider. Members sign in with their platform account.</Text>
      ) : (
        <>
          {moves.includes("require") || moves.includes("make-optional") ? (
            <Text>
              Only owners change whether sign-in through the identity provider is required.
              Requiring it needs your own current session to come from this identity provider.
            </Text>
          ) : null}
          <DescriptionList>
            <DescriptionTerm>Display name</DescriptionTerm>
            <DescriptionDetails>{provider.displayName}</DescriptionDetails>
            <ProtocolDetails provider={provider} />
            <DescriptionTerm>Just-in-time membership</DescriptionTerm>
            <DescriptionDetails>
              {provider.jit.kind === "enabled" ? `On, as ${provider.jit.role}` : "Off"}
            </DescriptionDetails>
            {provider.state.kind === "disabled" ? (
              <>
                <DescriptionTerm>Disabled</DescriptionTerm>
                <DescriptionDetails>
                  <Timestamp value={provider.state.disabledAt} />
                </DescriptionDetails>
              </>
            ) : null}
          </DescriptionList>
          <RegistrationValues provider={provider} />
        </>
      )}
      {dialog?.kind === "settings" ? (
        <ProviderSettingsDialog
          current={provider}
          linksVisible={access.listIdentityProviderLinks}
          onClose={close}
          organizationId={organizationId}
        />
      ) : null}
      {provider && dialog?.kind === "state" ? (
        <ProviderStateDialog
          move={dialog.move}
          onClose={close}
          organizationId={organizationId}
          provider={provider}
        />
      ) : null}
      {provider && dialog?.kind === "delete" ? (
        <DeleteProviderDialog onClose={close} organizationId={organizationId} provider={provider} />
      ) : null}
    </section>
  );
}

function ProtocolDetails({ provider }: Readonly<{ provider: IdentityProviderResponse }>) {
  switch (provider.protocol) {
    case "oidc":
      return (
        <>
          <DescriptionTerm>Protocol</DescriptionTerm>
          <DescriptionDetails>OpenID Connect</DescriptionDetails>
          <DescriptionTerm>Issuer</DescriptionTerm>
          <DescriptionDetails>
            <Code>{provider.issuer}</Code>
          </DescriptionDetails>
          <DescriptionTerm>Client ID</DescriptionTerm>
          <DescriptionDetails>
            <Code>{provider.clientId}</Code>
          </DescriptionDetails>
          <DescriptionTerm>Client secret</DescriptionTerm>
          <DescriptionDetails>
            Set <Timestamp value={provider.clientSecretSetAt} />
          </DescriptionDetails>
        </>
      );
    case "saml":
      return (
        <>
          <DescriptionTerm>Protocol</DescriptionTerm>
          <DescriptionDetails>SAML 2.0</DescriptionDetails>
          <DescriptionTerm>Entity ID</DescriptionTerm>
          <DescriptionDetails>
            <Code>{provider.issuer}</Code>
          </DescriptionDetails>
          <DescriptionTerm>Single sign-on URL</DescriptionTerm>
          <DescriptionDetails>
            <Code>{provider.singleSignOnUrl}</Code>
          </DescriptionDetails>
          <DescriptionTerm>Metadata</DescriptionTerm>
          <DescriptionDetails>
            {provider.metadataUrl === undefined ? (
              "Pasted XML"
            ) : (
              <Code>{provider.metadataUrl}</Code>
            )}
          </DescriptionDetails>
          <DescriptionTerm>Email</DescriptionTerm>
          <DescriptionDetails>
            {provider.emailAttribute === undefined ? (
              "An email-address NameID or a standard email attribute"
            ) : (
              <>
                The <Code>{provider.emailAttribute}</Code> attribute only, never the NameID
              </>
            )}
          </DescriptionDetails>
          <DescriptionTerm>IdP-initiated sign-in</DescriptionTerm>
          <DescriptionDetails>
            {provider.unsolicitedSignIn === "enabled" ? "On, with a confirmation page" : "Off"}
          </DescriptionDetails>
          <DescriptionTerm>Signing certificates</DescriptionTerm>
          <DescriptionDetails>
            <ul className="flex flex-col gap-1">
              {provider.signingCertificates.map((certificate) => (
                <li key={certificate.sha256Fingerprint}>
                  <Code className="break-all">{certificate.sha256Fingerprint}</Code>
                  <Text>
                    Expires <Timestamp value={certificate.notAfter} />
                  </Text>
                </li>
              ))}
            </ul>
          </DescriptionDetails>
        </>
      );
    default: {
      const unhandled: never = provider;
      return unhandled;
    }
  }
}

function RegistrationValues({ provider }: Readonly<{ provider: IdentityProviderResponse }>) {
  switch (provider.protocol) {
    case "oidc":
      return (
        <>
          <CopyField label="Redirect URI" value={provider.redirectUri} />
          <Text>Register this redirect URI with the identity provider's client.</Text>
        </>
      );
    case "saml":
      return (
        <>
          <ServiceProviderValues serviceProvider={provider.serviceProvider} />
          <Text>Register these values with the identity provider's SAML application.</Text>
        </>
      );
    default: {
      const unhandled: never = provider;
      return unhandled;
    }
  }
}
