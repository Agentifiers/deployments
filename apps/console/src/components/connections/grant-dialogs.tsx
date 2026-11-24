import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  parseGrantConstraints,
  type ConnectionView,
  type GrantRow,
} from "../../connections/connection-state.ts";
import { environmentQuery } from "../../data/console-queries.ts";
import { createGrantFn, revokeGrantFn } from "../../data/connection-mutations.ts";
import { invalidateConnections, workspacesQuery } from "../../data/connection-queries.ts";
import { formatExact } from "../../observability/format.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Checkbox } from "@/components/ui/checkbox";
import {
  CheckboxField,
  Description,
  Field,
  FieldGroup,
  Fieldset,
  Label,
  Legend,
} from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { Code, Text, TextLink } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";

/** The only purpose the agent runtime accepts when it resolves a pinned grant. */
const GRANT_PURPOSE = "agent-runtime";

/** Grants a provider connection or an MCP connection; the API accepts either ID. */
export function CreateGrantDialog({
  connection,
  grantableScopes,
  onClose,
  open,
  scope,
}: Readonly<{
  connection: Pick<ConnectionView, "displayName" | "id">;
  grantableScopes: readonly string[];
  onClose: () => void;
  open: boolean;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const workspaces = useQuery({ ...workspacesQuery(scope), enabled: open });
  const [workspaceId, setWorkspaceId] = useState("");
  const [scopes, setScopes] = useState<readonly string[]>([]);
  const [constraintsText, setConstraintsText] = useState("");
  useEffect(() => {
    if (!open) return;
    setWorkspaceId("");
    setScopes([]);
    setConstraintsText("");
  }, [open]);
  const active = (workspaces.data ?? []).filter((workspace) => workspace.status === "active");
  const constraints = parseGrantConstraints(constraintsText);
  const ready =
    active.some((workspace) => workspace.id === workspaceId) &&
    (scopes.length > 0 || grantableScopes.length === 0) &&
    constraints.ok;

  return (
    <ActionDialog
      confirmLabel="Grant"
      confirmation={typedConfirmation(environment.type, { phrase: connection.displayName })}
      description="Agent runs in the workspace can use this connection through tools a deployment pins to the grant."
      invalid={!ready}
      onClose={onClose}
      onSuccess={() => void invalidateConnections(queryClient, scope)}
      open={open}
      run={(idempotencyKey) => {
        if (!constraints.ok) throw new TypeError(constraints.message);
        return createGrantFn({
          data: {
            body: {
              connectionId: connection.id,
              purpose: GRANT_PURPOSE,
              scopes,
              workspaceId,
              ...(constraints.value ? { externalResourceConstraints: constraints.value } : {}),
            },
            idempotencyKey,
            scope,
          },
        });
      }}
      size="xl"
      successMessage="Grant created"
      title={`Grant ${connection.displayName} to a workspace`}
    >
      <Field disabled={workspaces.isPending}>
        <Label>Workspace</Label>
        {workspaces.isSuccess && active.length === 0 ? (
          <Description>
            This environment has no active workspace.{" "}
            <TextLink href={`${environmentPath(scope)}/workspaces`}>Create one first</TextLink>.
          </Description>
        ) : null}
        <NativeSelect onChange={(event) => setWorkspaceId(event.target.value)} value={workspaceId}>
          <option value="">
            {workspaces.isPending ? "Loading workspaces…" : "Choose a workspace"}
          </option>
          {active.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name} ({workspace.slug})
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Fieldset>
        <Legend>Scopes</Legend>
        {grantableScopes.length === 0 ? (
          <Text>The connection offers no scopes, so the grant carries none.</Text>
        ) : (
          <FieldGroup>
            {grantableScopes.map((grantScope) => (
              <CheckboxField key={grantScope}>
                <Checkbox
                  checked={scopes.includes(grantScope)}
                  onCheckedChange={(checked) =>
                    setScopes(
                      checked
                        ? [...scopes, grantScope].toSorted()
                        : scopes.filter((selected) => selected !== grantScope),
                    )
                  }
                />
                <Label className="font-mono">{grantScope}</Label>
              </CheckboxField>
            ))}
          </FieldGroup>
        )}
      </Fieldset>
      <Field>
        <Label>Purpose</Label>
        <Description>
          <Code>{GRANT_PURPOSE}</Code>, the only purpose the agent runtime accepts.
        </Description>
      </Field>
      <Field>
        <Label>Resource constraints (optional)</Label>
        <Description>
          A JSON object whose fields the runtime sets on every tool call this grant authorizes.
        </Description>
        <Textarea
          className="font-mono"
          aria-invalid={!constraints.ok}
          onChange={(event) => setConstraintsText(event.target.value)}
          rows={3}
          value={constraintsText}
        />
        {constraints.ok ? null : <Description>{constraints.message}</Description>}
      </Field>
    </ActionDialog>
  );
}

export function RevokeGrantDialog({
  onClose,
  row,
  scope,
}: Readonly<{ onClose: () => void; row: GrantRow; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const { grant, uses } = row;
  const phrase = grant.id.slice(-8);
  return (
    <ActionDialog
      confirmLabel="Revoke grant"
      confirmation={typedConfirmation(environment.type, { destructive: true, phrase })}
      description={
        uses.length === 0
          ? "No deployment pins this grant. Revoking cannot be undone."
          : `${formatExact(uses.length)} pinned ${uses.length === 1 ? "tool loses" : "tools lose"} access at the next run. Revoking cannot be undone.`
      }
      destructive
      onClose={onClose}
      onSuccess={() => void invalidateConnections(queryClient, scope)}
      open
      run={(idempotencyKey) =>
        revokeGrantFn({
          data: {
            body: { expectedVersion: grant.version },
            grantId: grant.id,
            idempotencyKey,
            scope,
          },
        })
      }
      successMessage="Grant revoked"
      title="Revoke this grant?"
    />
  );
}
