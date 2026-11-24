import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  grantImpact,
  type ConnectionView,
  type GrantView,
  type PinningDeploymentView,
  type ProviderCatalogEntry,
} from "../../connections/connection-state.ts";
import {
  credentialDocument,
  rotationSender,
  type CredentialFieldView,
  type RotationBody,
} from "../../connections/credential-form.ts";
import { appChoice } from "../../connections/oauth.ts";
import { searchAfterRotate, type RotateSearch } from "../../connections/rebind.ts";
import { environmentQuery } from "../../data/console-queries.ts";
import { createConnectionFn, rotateCredentialFn } from "../../data/connection-mutations.ts";
import {
  fetchConnectionVersionFn,
  invalidateConnections,
  providerCatalogQuery,
} from "../../data/connection-queries.ts";
import { beginAuthorizationFn } from "../../data/oauth-app-mutations.ts";
import { oauthAppsQuery } from "../../data/oauth-app-queries.ts";
import { formatExact } from "../../observability/format.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Description, Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Code } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";
import { useKeyedSnapshot } from "../keyed-snapshot.ts";
import { OAuthAppPicker } from "./oauth-app-picker.tsx";

const MAX_NAME_LENGTH = 120;

function plural(count: number, one: string, many: string) {
  return `${formatExact(count)} ${count === 1 ? one : many}`;
}

function CredentialFields({
  fields,
  onChange,
  values,
}: Readonly<{
  fields: readonly CredentialFieldView[];
  onChange: (values: Readonly<Record<string, string>>) => void;
  values: Readonly<Record<string, string>>;
}>) {
  return fields.map((field) => {
    const optional = !field.required || field.defaultValue !== undefined;
    const update = (value: string) => onChange({ ...values, [field.key]: value });
    return (
      <Field key={field.key}>
        <Label>
          {field.label}
          {optional ? " (optional)" : null}
        </Label>
        {field.description ? <Description>{field.description}</Description> : null}
        {field.multiline ? (
          <Textarea
            className="font-mono"
            onChange={(event) => update(event.target.value)}
            rows={6}
            value={values[field.key] ?? ""}
          />
        ) : (
          <Input
            autoComplete="off"
            onChange={(event) => update(event.target.value)}
            placeholder={field.defaultValue}
            type={field.sensitive ? "password" : "text"}
            value={values[field.key] ?? ""}
          />
        )}
      </Field>
    );
  });
}

function useOpenConnection(scope: EnvironmentScope) {
  const navigate = useNavigate();
  return (connection: ConnectionView) =>
    void navigate({
      params: {
        connectionId: connection.id,
        envId: scope.environmentId,
        orgId: scope.organizationId,
        projectId: scope.projectId,
      },
      to: "/o/$orgId/p/$projectId/e/$envId/connections/$connectionId",
    });
}

/** The tenant URL of a templated vendor MCP server, sent as `requestedResource`. */
export function TenantField({
  onChange,
  resource,
  value,
}: Readonly<{
  onChange: (value: string) => void;
  resource: NonNullable<ProviderCatalogEntry["resource"]>;
  value: string;
}>) {
  return (
    <Field>
      <Label>{resource.label}</Label>
      <Description>
        The MCP server URL with your tenant in place of <Code>{"{tenant}"}</Code>:{" "}
        <Code>{resource.template}</Code>.
      </Description>
      <Input
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        type="url"
        value={value}
      />
    </Field>
  );
}

/** The provider's consent page expires with the authorization attempt. */
export const CONSENT_NOTICE =
  "You sign in with the provider in this tab and have 10 minutes to finish there. The platform then sends you back to this console.";

type Added =
  | { readonly kind: "created"; readonly connection: ConnectionView }
  | { readonly kind: "redirect"; readonly authorizationUrl: string };

export function AddConnectionDialog({
  canAuthorize,
  onClose,
  open,
  scope,
}: Readonly<{
  canAuthorize: boolean;
  onClose: () => void;
  open: boolean;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const openConnection = useOpenConnection(scope);
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const catalog = useQuery({ ...providerCatalogQuery(), enabled: open });
  const [providerKey, setProviderKey] = useState("");
  const [name, setName] = useState("");
  const [resource, setResource] = useState("");
  const [appId, setAppId] = useState("");
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  useEffect(() => {
    if (!open) return;
    setProviderKey("");
    setName("");
    setResource("");
    setAppId("");
    setValues({});
  }, [open]);
  const providers = (catalog.data ?? []).filter(
    (entry) => canAuthorize || entry.access !== "oauth",
  );
  const provider = providers.find((entry) => entry.key === providerKey);
  const oauth = provider?.access === "oauth" ? provider.oauth : undefined;
  const apps = useQuery({ ...oauthAppsQuery(scope), enabled: open && oauth !== undefined });
  const choice =
    oauth && apps.data
      ? appChoice(apps.data.apps, { key: providerKey, requiresApp: oauth.requiresApp }, appId)
      : undefined;
  const document = provider ? credentialDocument(provider.fields, values) : undefined;
  const displayName = name.trim();
  const requestedResource = resource.trim();
  const resourceReady = provider?.resource === undefined || requestedResource.length > 0;
  const created =
    provider &&
    !oauth &&
    document?.ok &&
    displayName.length > 0 &&
    displayName.length <= MAX_NAME_LENGTH &&
    resourceReady
      ? {
          displayName,
          providerKey: provider.key,
          ...(document.credential ? { credential: document.credential } : {}),
          ...(provider.resource ? { requestedResource } : {}),
        }
      : undefined;
  const authorized =
    provider && oauth && (choice?.kind === "chosen" || choice?.kind === "platform") && resourceReady
      ? {
          providerKey: provider.key,
          ...(choice.kind === "chosen" ? { providerApplicationId: choice.app.id } : {}),
          ...(provider.resource ? { requestedResource } : {}),
        }
      : undefined;

  return (
    <ActionDialog
      confirmLabel={oauth ? "Authorize" : "Add connection"}
      confirmation={typedConfirmation(environment.type, {
        phrase: (oauth ? provider?.displayName : displayName) || "add",
      })}
      description={
        oauth
          ? CONSENT_NOTICE
          : "The credential goes to the platform's credential vault and is never shown again."
      }
      invalid={created === undefined && authorized === undefined}
      onClose={onClose}
      onSuccess={(added) => {
        if (added.kind === "redirect") {
          window.location.assign(added.authorizationUrl);
          return;
        }
        void invalidateConnections(queryClient, scope);
        openConnection(added.connection);
      }}
      open={open}
      run={async (idempotencyKey: string): Promise<Added> => {
        if (authorized) {
          const { authorizationUrl } = await beginAuthorizationFn({
            data: { body: authorized, idempotencyKey, scope, target: { kind: "connect" } },
          });
          return { authorizationUrl, kind: "redirect" };
        }
        if (!created) throw new TypeError("The connection form is incomplete.");
        const connection = await createConnectionFn({
          data: { body: created, idempotencyKey, scope },
        });
        return { connection, kind: "created" };
      }}
      size="xl"
      successMessage={(added) =>
        added.kind === "redirect" ? "Opening the provider's sign-in page" : "Connection added"
      }
      title="Add a connection"
    >
      <Field disabled={catalog.isPending}>
        <Label>Provider</Label>
        <NativeSelect
          onChange={(event) => {
            setProviderKey(event.target.value);
            setAppId("");
            setValues({});
          }}
          value={providerKey}
        >
          <option value="">{catalog.isPending ? "Loading providers…" : "Choose a provider"}</option>
          {providers.map((entry) => (
            <option key={entry.key} value={entry.key}>
              {entry.displayName}
            </option>
          ))}
        </NativeSelect>
        {provider?.access === "credentialless" ? (
          <Description>
            This provider needs no credential. The connection can be granted as soon as it exists.
          </Description>
        ) : null}
        {oauth ? (
          <Description>
            This provider signs in over OAuth. The platform names the connection after the account
            you authorize.
          </Description>
        ) : null}
      </Field>
      {provider && provider.access === "credential" && !provider.verifiable ? (
        <Callout>
          <CalloutTitle>This provider cannot be verified</CalloutTitle>
          <CalloutDescription>
            Only a verified connection can be granted to a workspace, so agents cannot use this
            connection yet.
          </CalloutDescription>
        </Callout>
      ) : null}
      {oauth && provider ? (
        <OAuthAppPicker
          choice={choice}
          error={apps.error}
          onPick={setAppId}
          providerName={provider.displayName}
          scope={scope}
        />
      ) : null}
      {oauth ? null : (
        <Field>
          <Label>Name</Label>
          <Input
            autoComplete="off"
            aria-invalid={
              name !== "" && (displayName === "" || displayName.length > MAX_NAME_LENGTH)
            }
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </Field>
      )}
      {provider?.resource ? (
        <TenantField onChange={setResource} resource={provider.resource} value={resource} />
      ) : null}
      {provider && !oauth ? (
        <CredentialFields fields={provider.fields} onChange={setValues} values={values} />
      ) : null}
    </ActionDialog>
  );
}

export function RotateCredentialDialog({
  connection,
  deployments,
  grants,
  onClose,
  onSubmit,
  open,
  rebind,
  scope,
}: Readonly<{
  connection: ConnectionView;
  deployments: readonly PinningDeploymentView[];
  grants: readonly GrantView[];
  onClose: () => void;
  /** Wraps the request so a 409 re-reads the connection before the dialog shows it. */
  onSubmit: <Result>(request: Promise<Result>) => Promise<Result>;
  open: boolean;
  /** The rebind this rotation retries, whose `since` the next rebind page keeps. */
  rebind?: RotateSearch;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const catalog = useQuery({ ...providerCatalogQuery(), enabled: open });
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const bodyFor = useKeyedSnapshot<RotationBody>();
  // Not `fetchQuery`: it could join a read in flight from before the refusal and miss its write.
  const liveVersion = () =>
    fetchConnectionVersionFn({ data: { connectionId: connection.id, scope } });
  const rotate = useRef(rotationSender(liveVersion));
  useEffect(() => {
    if (!open) return;
    setValues({});
    rotate.current = rotationSender(liveVersion);
  }, [open]);
  const fields = catalog.data?.find((entry) => entry.key === connection.providerKey)?.fields;
  const document = fields ? credentialDocument(fields, values) : undefined;
  const credential = document?.ok ? document.credential : undefined;
  const impact = grantImpact(connection.id, grants, deployments, "active");

  return (
    <ActionDialog
      confirmLabel="Rotate credential"
      confirmation={typedConfirmation(environment.type, {
        destructive: true,
        phrase: connection.displayName,
      })}
      description="Enter every field again; the new credential replaces the stored one as a whole."
      destructive
      invalid={credential === undefined}
      onClose={onClose}
      onSuccess={(rotated) => {
        void invalidateConnections(queryClient, scope);
        void navigate({
          params: {
            connectionId: rotated.id,
            envId: scope.environmentId,
            orgId: scope.organizationId,
            projectId: scope.projectId,
          },
          search: searchAfterRotate(rotated.updatedAt, rebind),
          to: "/o/$orgId/p/$projectId/e/$envId/connections/$connectionId/rebind",
        });
      }}
      open={open}
      retryNotice="The rotation may be half done: the stored credential can already be replaced and the grants revoked. Submit again to finish it. Closing leaves the connection unusable until you revoke it."
      run={(idempotencyKey: string, resend: boolean) => {
        if (!credential) throw new TypeError("The credential form is incomplete.");
        const body = bodyFor(idempotencyKey, resend, {
          credential,
          expectedVersion: connection.version,
        });
        return onSubmit(
          rotate.current({ key: idempotencyKey, value: body }, (request) =>
            rotateCredentialFn({
              data: {
                body: request.value,
                connectionId: connection.id,
                idempotencyKey: request.key,
                scope,
              },
            }),
          ),
        );
      }}
      size="xl"
      successMessage="Credential rotated"
      title={`Rotate the credential of ${connection.displayName}`}
    >
      <Callout variant="destructive">
        <CalloutTitle>
          Replaces the stored credential and revokes{" "}
          {plural(impact.grants, "active grant", "active grants")}
        </CalloutTitle>
        <CalloutDescription>
          <p>The old credential cannot be restored.</p>
          <p>
            {plural(impact.deployments, "deployment has", "deployments have")} these tools denied
            until the new credential verifies and the next page restores the grants and pins.
          </p>
        </CalloutDescription>
      </Callout>
      {fields ? <CredentialFields fields={fields} onChange={setValues} values={values} /> : null}
    </ActionDialog>
  );
}
