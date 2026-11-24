import { ResourceName } from "@deployments-ai/api-contract/primitives";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { useState } from "react";
import { scopeGroups, type ScopeGroup, type ServiceAccountView } from "../../api-keys/directory.ts";
import { createServiceAccountFn, revokeServiceAccountFn } from "../../data/api-key-mutations.ts";
import { invalidateApiKeys } from "../../data/api-key-queries.ts";
import { environmentQuery, organizationShellQuery } from "../../data/console-queries.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Checkbox } from "@/components/ui/checkbox";
import { CheckboxField, Description, Field, FieldGroup, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";

export const isResourceName = Schema.is(ResourceName);

export function ScopePicker({
  description,
  groups,
  onChange,
  value,
}: Readonly<{
  description: string;
  groups: readonly ScopeGroup[];
  onChange: (scopes: readonly string[]) => void;
  value: readonly string[];
}>) {
  return (
    <Field>
      <Label>Scopes</Label>
      <Description>{description}</Description>
      <div className="grid max-h-72 gap-x-6 gap-y-4 overflow-y-auto rounded-lg border border-border p-3 sm:grid-cols-3">
        {groups.map((group) => (
          <FieldGroup key={group.namespace}>
            {group.scopes.map((scope) => (
              <CheckboxField key={scope}>
                <Checkbox
                  checked={value.includes(scope)}
                  onCheckedChange={(checked) =>
                    onChange(
                      checked
                        ? [...value, scope].toSorted()
                        : value.filter((chosen) => chosen !== scope),
                    )
                  }
                />
                <Label className="font-mono">{scope}</Label>
              </CheckboxField>
            ))}
          </FieldGroup>
        ))}
      </div>
    </Field>
  );
}

export function CreateServiceAccountDialog({
  onClose,
  scope,
}: Readonly<{ onClose: () => void; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scopes, setScopes] = useState<readonly string[]>([]);
  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  return (
    <ActionDialog
      confirmLabel="Create service account"
      confirmation={typedConfirmation(environment.type, { phrase: trimmedName || "create" })}
      description="A service account is the identity your backend authenticates as. Its API keys can hold only scopes the account holds."
      invalid={!isResourceName(trimmedName) || scopes.length === 0}
      onClose={onClose}
      onSuccess={() => void invalidateApiKeys(queryClient, scope)}
      open
      run={(idempotencyKey) =>
        createServiceAccountFn({
          data: {
            body: {
              name: trimmedName,
              ...(trimmedDescription ? { description: trimmedDescription } : {}),
              scopes,
            },
            idempotencyKey,
            scope,
          },
        })
      }
      size="2xl"
      successMessage="Service account created"
      title="Create service account"
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
      <Field>
        <Label>Description</Label>
        <Textarea
          onChange={(event) => setDescription(event.target.value)}
          resizable={false}
          rows={2}
          value={description}
        />
      </Field>
      <ScopePicker
        description="At least one. You can grant only scopes your own role and token hold."
        groups={scopeGroups(shell.authorization.capabilities)}
        onChange={setScopes}
        value={scopes}
      />
    </ActionDialog>
  );
}

export function RevokeServiceAccountDialog({
  account,
  activeKeys,
  onClose,
  scope,
}: Readonly<{
  account: ServiceAccountView;
  activeKeys: number;
  onClose: () => void;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  return (
    <ActionDialog
      confirmLabel="Revoke service account"
      confirmation={typedConfirmation(environment.type, {
        destructive: true,
        phrase: account.name,
      })}
      description={`Every API key of ${account.name} stops working at once (${activeKeys} active now), and the account cannot issue keys again. Revoking cannot be undone.`}
      destructive
      onClose={onClose}
      onSuccess={() => void invalidateApiKeys(queryClient, scope)}
      open
      run={(idempotencyKey) =>
        revokeServiceAccountFn({
          data: { idempotencyKey, scope, serviceAccountId: account.id },
        })
      }
      successMessage="Service account revoked"
      title={`Revoke ${account.name}?`}
    />
  );
}
