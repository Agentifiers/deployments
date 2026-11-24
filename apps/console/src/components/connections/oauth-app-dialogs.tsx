import { Copy01Icon } from "@hugeicons/core-free-icons";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type {
  ProviderCatalogEntry,
  ProviderOAuthEntry,
  TokenEndpointAuthMethod,
} from "../../connections/connection-state.ts";
import { oauthCallbackUri, type OAuthAppView } from "../../connections/oauth.ts";
import { environmentQuery } from "../../data/console-queries.ts";
import { providerCatalogQuery } from "../../data/connection-queries.ts";
import {
  archiveOAuthAppFn,
  createOAuthAppFn,
  rotateOAuthAppSecretFn,
} from "../../data/oauth-app-mutations.ts";
import { oauthAppsQuery } from "../../data/oauth-app-queries.ts";
import { PlatformApiError } from "../../errors.ts";
import { formatExact } from "../../observability/format.ts";
import type { EnvironmentScope } from "../../scope.ts";
import type { AppConnection } from "../../server/oauth-app-data.ts";
import { Button } from "@/components/ui/button";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Checkbox } from "@/components/ui/checkbox";
import { CheckboxField, Description, Field, FieldGroup, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Code } from "@/components/ui/text";
import { toast } from "@/components/ui/sonner";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";
import { Icon } from "../icon.tsx";

const MAX_NAME_LENGTH = 120;

const AUTH_METHOD_LABELS: Readonly<Record<TokenEndpointAuthMethod, string>> = {
  client_secret_basic: "Client secret in the Authorization header (client_secret_basic)",
  client_secret_post: "Client secret in the request body (client_secret_post)",
  none: "No client secret, PKCE only (none)",
};

/** The platform's default for a pre-registered client: the first method that uses a secret. */
function defaultAuthMethod(methods: readonly TokenEndpointAuthMethod[]) {
  return methods.find((method) => method !== "none") ?? "none";
}

export function CallbackUri({
  callbackOrigin,
  oauth,
}: Readonly<{ callbackOrigin: string | undefined; oauth: ProviderOAuthEntry }>) {
  const callback = oauthCallbackUri(callbackOrigin, oauth);
  const { copyToClipboard } = useCopyToClipboard({
    timeout: 0,
    onCopy: () => toast.success("Copied the redirect URI."),
    onError: () => toast.error("Copying failed. Select the value and copy it."),
  });
  return (
    <Field>
      <Label>Redirect URI</Label>
      <Description>
        {callback.complete
          ? "Register exactly this URI with the provider's OAuth app."
          : "This console does not know the platform's channel API address. Replace the placeholder with the channel API endpoint before registering the URI with the provider."}
      </Description>
      <div className="flex items-center gap-2">
        <Input aria-label="Redirect URI" className="font-mono" readOnly value={callback.uri} />
        <Button
          aria-label="Copy the redirect URI"
          onClick={() => copyToClipboard(callback.uri)}
          variant="outline"
        >
          <Icon icon={Copy01Icon} />
          Copy
        </Button>
      </div>
    </Field>
  );
}

function ScopeChoices({
  available,
  onChange,
  value,
}: Readonly<{
  available: readonly string[];
  onChange: (scopes: readonly string[]) => void;
  value: readonly string[];
}>) {
  if (available.length === 0) {
    return (
      <Field>
        <Label>Scopes</Label>
        <Description>The provider defines no scopes to request.</Description>
      </Field>
    );
  }
  return (
    <Field>
      <Label>Scopes</Label>
      <Description>
        The app may request only these scopes. Every connection asks for them.
      </Description>
      <FieldGroup className="max-h-56 overflow-y-auto rounded-lg border border-border p-3">
        {available.map((scope) => (
          <CheckboxField key={scope}>
            <Checkbox
              checked={value.includes(scope)}
              onCheckedChange={(checked) =>
                onChange(
                  checked
                    ? available.filter((entry) => entry === scope || value.includes(entry))
                    : value.filter((entry) => entry !== scope),
                )
              }
            />
            <Label className="font-mono">{scope}</Label>
          </CheckboxField>
        ))}
      </FieldGroup>
    </Field>
  );
}

/** A duplicate client ID is a 409 even when the app holding it is archived. */
async function claimingClientId<Result>(request: Promise<Result>) {
  try {
    return await request;
  } catch (error) {
    if (error instanceof PlatformApiError && error.problem.code === "version_conflict") {
      const { code: _code, ...problem } = error.problem;
      throw new PlatformApiError(error.operation, {
        ...problem,
        detail:
          "An app in this environment already uses this client ID, possibly an archived one. Client IDs stay claimed after archiving, so register a new client with the provider.",
        title: "Client ID already registered",
      });
    }
    throw error;
  }
}

export function RegisterOAuthAppDialog({
  callbackOrigin,
  onClose,
  open,
  scope,
}: Readonly<{
  callbackOrigin: string | undefined;
  onClose: () => void;
  open: boolean;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const catalog = useQuery({ ...providerCatalogQuery(), enabled: open });
  const [providerKey, setProviderKey] = useState("");
  const [name, setName] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [scopes, setScopes] = useState<readonly string[]>([]);
  const [method, setMethod] = useState<TokenEndpointAuthMethod>();
  useEffect(() => {
    if (!open) return;
    setProviderKey("");
    setName("");
    setClientId("");
    setClientSecret("");
    setScopes([]);
    setMethod(undefined);
  }, [open]);
  const providers = (catalog.data ?? []).flatMap((entry) =>
    entry.access === "oauth" ? [entry] : [],
  );
  const provider = providers.find((entry) => entry.key === providerKey);
  const methods = provider?.oauth.tokenEndpointAuthMethods;
  const authMethod = methods ? (method ?? defaultAuthMethod(methods)) : undefined;
  const callback = provider ? oauthCallbackUri(callbackOrigin, provider.oauth) : undefined;
  const displayName = name.trim();
  const id = clientId.trim();
  const secret = clientSecret.trim();
  const body =
    provider &&
    displayName.length > 0 &&
    displayName.length <= MAX_NAME_LENGTH &&
    id.length > 0 &&
    (secret.length > 0 || authMethod === "none")
      ? {
          clientId: id,
          displayName,
          providerKey: provider.key,
          redirectUris: callback?.complete ? [callback.uri] : [],
          requestedScopes: scopes,
          ...(secret.length > 0 ? { clientSecret: secret } : {}),
          ...(authMethod
            ? {
                registration: {
                  method: "pre_registered" as const,
                  tokenEndpointAuthMethod: authMethod,
                },
              }
            : {}),
        }
      : undefined;
  const choose = (entry: Extract<ProviderCatalogEntry, { access: "oauth" }> | undefined) => {
    setProviderKey(entry?.key ?? "");
    setScopes(entry?.oauth.appScopes ?? []);
    setMethod(undefined);
  };

  return (
    <ActionDialog
      confirmLabel="Register app"
      confirmation={typedConfirmation(environment.type, { phrase: displayName || "register" })}
      description="Register the OAuth client you created with the provider. The client secret goes to the platform's credential vault and is never shown again."
      invalid={body === undefined}
      onClose={onClose}
      onSuccess={() =>
        void queryClient.invalidateQueries({ queryKey: oauthAppsQuery(scope).queryKey })
      }
      open={open}
      run={(idempotencyKey: string) => {
        if (!body) throw new TypeError("The OAuth app form is incomplete.");
        return claimingClientId(createOAuthAppFn({ data: { body, idempotencyKey, scope } }));
      }}
      size="2xl"
      successMessage={(app) => `Registered ${app.displayName}`}
      title="Register an OAuth app"
    >
      <Field disabled={catalog.isPending}>
        <Label>Provider</Label>
        <NativeSelect
          onChange={(event) => choose(providers.find((entry) => entry.key === event.target.value))}
          value={providerKey}
        >
          <option value="">{catalog.isPending ? "Loading providers…" : "Choose a provider"}</option>
          {providers.map((entry) => (
            <option key={entry.key} value={entry.key}>
              {entry.displayName}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {provider ? <CallbackUri callbackOrigin={callbackOrigin} oauth={provider.oauth} /> : null}
      <Field>
        <Label>Name</Label>
        <Input
          autoComplete="off"
          aria-invalid={name !== "" && (displayName === "" || displayName.length > MAX_NAME_LENGTH)}
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
      </Field>
      <Field>
        <Label>Client ID</Label>
        <Input
          autoComplete="off"
          onChange={(event) => setClientId(event.target.value)}
          value={clientId}
        />
      </Field>
      {methods ? (
        <Field>
          <Label>Token endpoint authentication</Label>
          <NativeSelect
            onChange={(event) => {
              const next = methods.find((entry) => entry === event.target.value);
              if (next) setMethod(next);
            }}
            value={authMethod}
          >
            {methods.map((entry) => (
              <option key={entry} value={entry}>
                {AUTH_METHOD_LABELS[entry]}
              </option>
            ))}
          </NativeSelect>
        </Field>
      ) : null}
      <Field>
        <Label>Client secret{authMethod === "none" ? " (optional)" : null}</Label>
        <Input
          autoComplete="off"
          onChange={(event) => setClientSecret(event.target.value)}
          type="password"
          value={clientSecret}
        />
      </Field>
      {provider ? (
        <ScopeChoices available={provider.oauth.appScopes} onChange={setScopes} value={scopes} />
      ) : null}
    </ActionDialog>
  );
}

/** Live connections that refresh through an app; partial when the list was cut off. */
interface AppConnections {
  readonly complete: boolean;
  readonly items: readonly AppConnection[];
}

function AppConnectionsCallout({
  connections,
  destructive,
  impact,
}: Readonly<{ connections: AppConnections; destructive: boolean; impact: string }>) {
  const { complete, items } = connections;
  if (items.length === 0 && complete) return null;
  return (
    <Callout variant={destructive ? "destructive" : "default"}>
      <CalloutTitle>
        {formatExact(items.length)}
        {complete ? "" : "+"} {items.length === 1 ? "connection uses" : "connections use"} this app
      </CalloutTitle>
      <CalloutDescription>
        <p>{impact}</p>
        <ul className="mt-2 flex flex-col gap-1">
          {items.map((connection) => (
            <li key={connection.id}>
              {connection.displayName} <Code>{connection.id}</Code>
            </li>
          ))}
        </ul>
      </CalloutDescription>
    </Callout>
  );
}

export function RotateOAuthAppSecretDialog({
  app,
  callbackOrigin,
  connections,
  oauth,
  onClose,
  open,
  scope,
}: Readonly<{
  app: OAuthAppView;
  callbackOrigin: string | undefined;
  connections: AppConnections;
  oauth: ProviderOAuthEntry | undefined;
  onClose: () => void;
  open: boolean;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [clientSecret, setClientSecret] = useState("");
  useEffect(() => {
    if (open) setClientSecret("");
  }, [open]);
  const secret = clientSecret.trim();
  return (
    <ActionDialog
      confirmLabel="Rotate secret"
      confirmation={typedConfirmation(environment.type, {
        destructive: true,
        phrase: app.displayName,
      })}
      description="The new client secret replaces the stored one for every connection that refreshes through this app."
      invalid={secret.length === 0}
      onClose={onClose}
      onSuccess={() =>
        void queryClient.invalidateQueries({ queryKey: oauthAppsQuery(scope).queryKey })
      }
      open={open}
      run={(idempotencyKey: string) =>
        rotateOAuthAppSecretFn({
          data: {
            appId: app.id,
            body: { clientSecret: secret, expectedVersion: app.version },
            idempotencyKey,
            scope,
          },
        })
      }
      successMessage="Client secret rotated"
      title={`Rotate the client secret of ${app.displayName}`}
    >
      <AppConnectionsCallout
        connections={connections}
        destructive={false}
        impact="A wrong secret makes their next token refresh fail."
      />
      {oauth ? <CallbackUri callbackOrigin={callbackOrigin} oauth={oauth} /> : null}
      <Field>
        <Label>Client secret</Label>
        <Input
          autoComplete="off"
          onChange={(event) => setClientSecret(event.target.value)}
          type="password"
          value={clientSecret}
        />
      </Field>
    </ActionDialog>
  );
}

export function ArchiveOAuthAppDialog({
  app,
  connections,
  onClose,
  open,
  scope,
}: Readonly<{
  app: OAuthAppView;
  connections: AppConnections;
  onClose: () => void;
  open: boolean;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  return (
    <ActionDialog
      confirmLabel="Archive app"
      confirmation={typedConfirmation(environment.type, {
        destructive: true,
        phrase: app.displayName,
      })}
      description="Archiving cannot be undone. New authorizations cannot use the app, and its client ID stays claimed in this environment."
      destructive
      onClose={onClose}
      onSuccess={() =>
        void queryClient.invalidateQueries({ queryKey: oauthAppsQuery(scope).queryKey })
      }
      open={open}
      run={(idempotencyKey: string) =>
        archiveOAuthAppFn({
          data: { appId: app.id, body: { expectedVersion: app.version }, idempotencyKey, scope },
        })
      }
      successMessage="OAuth app archived"
      title={`Archive ${app.displayName}?`}
    >
      <AppConnectionsCallout
        connections={connections}
        destructive
        impact="They fail at their next token refresh. Register another app, then reauthorize them with it."
      />
    </ActionDialog>
  );
}
