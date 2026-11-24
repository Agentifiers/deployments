import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  allowedAccountActions,
  scopeGroups,
  type ApiKeyView,
  type ServiceAccountView,
} from "../../api-keys/directory.ts";
import { issueApiKeyFn, revokeApiKeyFn, rotateApiKeyFn } from "../../data/api-key-mutations.ts";
import { invalidateApiKeys } from "../../data/api-key-queries.ts";
import { environmentQuery, organizationShellQuery } from "../../data/console-queries.ts";
import { DAY_MS } from "../../observability/range.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import { Callout, CalloutAction, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Description, Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Code } from "@/components/ui/text";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { SecretActionDialog } from "../secret-action-dialog.tsx";
import {
  CreateServiceAccountDialog,
  isResourceName,
  RevokeServiceAccountDialog,
  ScopePicker,
} from "./service-account-dialogs.tsx";

export type AccessDialog =
  | { readonly kind: "create-account" }
  | {
      readonly kind: "revoke-account";
      readonly account: ServiceAccountView;
      readonly activeKeys: number;
    }
  | {
      readonly kind: "issue-key";
      readonly account: ServiceAccountView;
      readonly scopes?: readonly string[];
    }
  | {
      readonly kind: "rotate-key";
      readonly account: ServiceAccountView | undefined;
      readonly apiKey: ApiKeyView;
    }
  | { readonly kind: "revoke-key"; readonly apiKey: ApiKeyView };

const KEY_LIFETIMES = [
  { days: undefined, label: "Never expires" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
] as const;

function useOpenKeyPage(scope: EnvironmentScope) {
  const navigate = useNavigate();
  return (key: ApiKeyView) =>
    void navigate({
      params: {
        apiCredentialId: key.id,
        envId: scope.environmentId,
        orgId: scope.organizationId,
        projectId: scope.projectId,
      },
      to: "/o/$orgId/p/$projectId/e/$envId/api-keys/$apiCredentialId",
    });
}

export function AccessDialogs({
  dialog,
  onDialog,
  scope,
}: Readonly<{
  dialog: AccessDialog | undefined;
  onDialog: (dialog: AccessDialog | undefined) => void;
  scope: EnvironmentScope;
}>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const close = () => onDialog(undefined);
  switch (dialog?.kind) {
    case undefined:
      return null;
    case "create-account":
      return <CreateServiceAccountDialog onClose={close} scope={scope} />;
    case "revoke-account":
      return (
        <RevokeServiceAccountDialog
          account={dialog.account}
          activeKeys={dialog.activeKeys}
          onClose={close}
          scope={scope}
        />
      );
    case "issue-key":
      return (
        <IssueApiKeyDialog
          account={dialog.account}
          initialScopes={dialog.scopes}
          onClose={close}
          scope={scope}
        />
      );
    case "rotate-key": {
      const { account, apiKey } = dialog;
      const canIssue =
        account !== undefined && allowedAccountActions(account, shell.access).includes("issue-key");
      return (
        <RotateApiKeyDialog
          apiKey={apiKey}
          onClose={close}
          onIssueSecond={
            canIssue
              ? () => onDialog({ account, kind: "issue-key", scopes: apiKey.scopes })
              : undefined
          }
          scope={scope}
        />
      );
    }
    case "revoke-key":
      return <RevokeApiKeyDialog apiKey={dialog.apiKey} onClose={close} scope={scope} />;
    default: {
      const unhandled: never = dialog;
      return unhandled;
    }
  }
}

function IssueApiKeyDialog({
  account,
  initialScopes,
  onClose,
  scope,
}: Readonly<{
  account: ServiceAccountView;
  initialScopes: readonly string[] | undefined;
  onClose: () => void;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const openKeyPage = useOpenKeyPage(scope);
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const groups = scopeGroups(account.scopes);
  const offered = groups.flatMap((group) => group.scopes);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<readonly string[]>(
    () => initialScopes?.filter((chosen) => offered.includes(chosen)) ?? offered,
  );
  const [lifetime, setLifetime] = useState<{ readonly days: number; readonly expiresAt: string }>();
  const expiresAt = lifetime?.expiresAt;
  const trimmedName = name.trim();
  return (
    <SecretActionDialog<ApiKeyView>
      confirmLabel="Issue key"
      confirmation={typedConfirmation(environment.type, { phrase: trimmedName || "issue" })}
      description={`The key authenticates as ${account.name} with the scopes you keep; a key cannot hold scopes its account lacks.`}
      invalid={!isResourceName(trimmedName) || scopes.length === 0}
      onClose={onClose}
      onIssued={() => void invalidateApiKeys(queryClient, scope)}
      onStored={openKeyPage}
      open
      run={(idempotencyKey) =>
        issueApiKeyFn({
          data: {
            body: {
              ...(expiresAt === undefined ? {} : { expiresAt }),
              name: trimmedName,
              scopes,
              serviceAccountId: account.id,
            },
            idempotencyKey,
            scope,
          },
        })
      }
      secretDescription={(key) => (
        <>
          {key.name} authenticates as {account.name}. Send it as{" "}
          <Code>Authorization: Bearer &lt;key&gt;</Code>.
        </>
      )}
      secretLabel="API key"
      size="2xl"
      successMessage="API key issued"
      title={`Issue an API key for ${account.name}`}
    >
      <Field>
        <Label>Name</Label>
        <Input
          autoComplete="off"
          aria-invalid={name !== "" && !isResourceName(trimmedName)}
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
      </Field>
      <ScopePicker
        description="At least one, from the account's scopes."
        groups={groups}
        onChange={setScopes}
        value={scopes}
      />
      <Field>
        <Label>Expires</Label>
        <Description>
          {expiresAt === undefined ? (
            "The key works until it or its account is revoked."
          ) : (
            <>
              The key stops working at <Timestamp value={expiresAt} />.
            </>
          )}
        </Description>
        <NativeSelect
          onChange={(event) => {
            const days = Number(event.target.value);
            setLifetime(
              days > 0
                ? { days, expiresAt: new Date(Date.now() + days * DAY_MS).toISOString() }
                : undefined,
            );
          }}
          value={lifetime?.days ?? ""}
        >
          {KEY_LIFETIMES.map((choice) => (
            <option key={choice.label} value={choice.days ?? ""}>
              {choice.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
    </SecretActionDialog>
  );
}

function RotateApiKeyDialog({
  apiKey,
  onClose,
  onIssueSecond,
  scope,
}: Readonly<{
  apiKey: ApiKeyView;
  onClose: () => void;
  onIssueSecond: (() => void) | undefined;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const openKeyPage = useOpenKeyPage(scope);
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [rotating, setRotating] = useState(false);
  return (
    <SecretActionDialog<ApiKeyView>
      confirmLabel="Rotate key"
      confirmation={typedConfirmation(environment.type, { destructive: true, phrase: apiKey.name })}
      description="The current secret stops working the moment the new one is issued; there is no overlap. Every caller still sending it gets 401 until it switches to the new secret."
      destructive
      onClose={onClose}
      onIssued={() => void invalidateApiKeys(queryClient, scope)}
      onStored={openKeyPage}
      open
      run={async (idempotencyKey) => {
        setRotating(true);
        try {
          return await rotateApiKeyFn({
            data: { apiCredentialId: apiKey.id, idempotencyKey, scope },
          });
        } finally {
          setRotating(false);
        }
      }}
      secretDescription={(key) => (
        <>
          The previous secret of {key.name} no longer authenticates. The new secret starts with{" "}
          <Code>{key.keyPrefix}</Code>.
        </>
      )}
      secretLabel="API key"
      successMessage="API key rotated"
      title={`Rotate ${apiKey.name}?`}
    >
      {onIssueSecond ? (
        <Callout>
          <CalloutTitle>Callers that cannot pause</CalloutTitle>
          <CalloutDescription>
            Issue a second key with the same account and scopes, move callers to it, then revoke
            this one.
          </CalloutDescription>
          <CalloutAction>
            <Button disabled={rotating} onClick={onIssueSecond} variant="outline" type="button">
              Issue a second key instead
            </Button>
          </CalloutAction>
        </Callout>
      ) : null}
    </SecretActionDialog>
  );
}

function RevokeApiKeyDialog({
  apiKey,
  onClose,
  scope,
}: Readonly<{ apiKey: ApiKeyView; onClose: () => void; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  return (
    <ActionDialog
      confirmLabel="Revoke key"
      confirmation={typedConfirmation(environment.type, { destructive: true, phrase: apiKey.name })}
      description="Callers sending this key get 401 from their next request. Revoking cannot be undone."
      destructive
      onClose={onClose}
      onSuccess={() => void invalidateApiKeys(queryClient, scope)}
      open
      run={(idempotencyKey) =>
        revokeApiKeyFn({ data: { apiCredentialId: apiKey.id, idempotencyKey, scope } })
      }
      successMessage="API key revoked"
      title={`Revoke ${apiKey.name}?`}
    />
  );
}
