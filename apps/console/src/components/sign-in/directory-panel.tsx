import type { DirectoryResponse } from "@deployments-ai/api-contract";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { OperationAccess } from "../../access.ts";
import {
  createDirectoryTokenFn,
  putDirectoryFn,
  revokeDirectoryTokenFn,
} from "../../data/directory-sync-mutations.ts";
import { directoryQuery, invalidateDirectory } from "../../data/directory-sync-queries.ts";
import { oneOf } from "../../observability/range.ts";
import {
  DIRECTORY_ROLES,
  defaultRoleRequest,
  directoryView,
  revokeConsequence,
  type DirectoryRole,
  type DirectoryToken,
} from "../../sign-in/directory.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Description, Field, Label } from "@/components/ui/field";
import { Subheading } from "@/components/ui/heading";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code, Text } from "@/components/ui/text";
import { ActionDialog, refreshOnConflict } from "../action-dialog.tsx";
import { CopyField } from "../copy-field.tsx";
import { Icon } from "../icon.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { SecretActionDialog } from "../secret-action-dialog.tsx";

const ROLE_LABELS: Readonly<Record<DirectoryRole, string>> = {
  member: "Member: uses agents and apps",
  viewer: "Viewer: reads only",
};

type DirectoryDialog =
  | { readonly kind: "create-token" }
  | { readonly kind: "default-role" }
  | { readonly kind: "revoke"; readonly token: DirectoryToken };

export function DirectoryPanel({
  access,
  organizationId,
}: Readonly<{ access: OperationAccess; organizationId: string }>) {
  const { data: directory } = useSuspenseQuery(directoryQuery(organizationId));
  const view = directoryView(directory);
  const [dialog, setDialog] = useState<DirectoryDialog>();
  const close = () => setDialog(undefined);
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Subheading>Directory sync</Subheading>
        <Badge color={view.kind === "on" ? "green" : "zinc"}>{view.kind}</Badge>
        {access.putDirectory ? (
          <Button
            className="ml-auto"
            onClick={() => setDialog({ kind: "default-role" })}
            variant="outline"
          >
            {view.kind === "on" ? "Change default role" : "Turn on"}
          </Button>
        ) : null}
      </div>
      <Text>
        Your identity provider adds, updates, and removes members through SCIM 2.0. Removing a
        member ends their membership in this organization and leaves their account in place.
      </Text>
      {view.kind === "off" ? (
        <Text>Directory sync is off.</Text>
      ) : (
        <>
          <DescriptionList>
            <DescriptionTerm>Default role</DescriptionTerm>
            <DescriptionDetails>{view.directory.defaultRole}</DescriptionDetails>
            <DescriptionTerm>Turned on</DescriptionTerm>
            <DescriptionDetails>
              <Timestamp value={view.directory.createdAt} />
            </DescriptionDetails>
          </DescriptionList>
          <CopyField label="SCIM base URL" value={view.directory.scimBaseUrl} />
          <Text>Paste this URL into your identity provider's SCIM connection.</Text>
          <div className="flex flex-wrap items-center gap-3">
            <Subheading level={3}>Tokens</Subheading>
            {access.createDirectoryToken ? (
              <Button
                className="ml-auto"
                disabled={view.slots.kind === "full"}
                onClick={() => setDialog({ kind: "create-token" })}
                variant="outline"
              >
                <Icon icon={PlusSignIcon} />
                Create token
              </Button>
            ) : null}
          </div>
          {view.slots.kind === "full" ? <Text>{view.slots.reason}</Text> : null}
          {view.slots.kind === "empty" ? (
            <Text>
              No tokens. Create one and paste it into your identity provider as the bearer token.
            </Text>
          ) : (
            <Table dense striped>
              <TableHeader>
                <TableRow>
                  <TableHead>Prefix</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Created by</TableHead>
                  {access.revokeDirectoryToken ? (
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.tokens.map((token) => (
                  <TableRow key={token.id}>
                    <TableCell>
                      <Code>{token.tokenPrefix}…</Code>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Timestamp value={token.createdAt} />
                    </TableCell>
                    <TableCell>
                      <PublicId value={token.createdBy} />
                    </TableCell>
                    {access.revokeDirectoryToken ? (
                      <TableCell>
                        <div className="flex justify-end">
                          <Button
                            onClick={() => setDialog({ kind: "revoke", token })}
                            variant="ghost"
                          >
                            Revoke
                          </Button>
                        </div>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
      {dialog?.kind === "default-role" ? (
        <DefaultRoleDialog directory={directory} onClose={close} organizationId={organizationId} />
      ) : null}
      {dialog?.kind === "create-token" ? (
        <CreateTokenDialog onClose={close} organizationId={organizationId} />
      ) : null}
      {directory && dialog?.kind === "revoke" ? (
        <RevokeTokenDialog
          directory={directory}
          onClose={close}
          organizationId={organizationId}
          token={dialog.token}
        />
      ) : null}
    </section>
  );
}

function DefaultRoleDialog({
  directory,
  onClose,
  organizationId,
}: Readonly<{
  directory: DirectoryResponse | null;
  onClose: () => void;
  organizationId: string;
}>) {
  const queryClient = useQueryClient();
  const [role, setRole] = useState<DirectoryRole>(directory?.defaultRole ?? "member");
  const request = defaultRoleRequest(directory, role);
  const refresh = () => invalidateDirectory(queryClient, organizationId);
  return (
    <ActionDialog
      confirmLabel={directory ? "Save changes" : "Turn on"}
      description="The role a member gets when your identity provider adds or reactivates them. Owners and admins keep their roles."
      invalid={request.kind === "unchanged"}
      onClose={onClose}
      onSuccess={() => void refresh()}
      open
      run={(idempotencyKey) => {
        if (request.kind === "unchanged") throw new TypeError("The default role is unchanged.");
        return refreshOnConflict(
          putDirectoryFn({
            data: { body: request.body, idempotencyKey, scope: { organizationId } },
          }),
          refresh,
        );
      }}
      successMessage={directory ? "Default role saved" : "Directory sync turned on"}
      title={directory ? "Change the default role" : "Turn on directory sync"}
    >
      <Field>
        <Label>Default role</Label>
        <Description>SCIM never grants owner or admin.</Description>
        <NativeSelect
          name="defaultRole"
          onChange={(event) => {
            const chosen = oneOf(DIRECTORY_ROLES, event.target.value);
            if (chosen) setRole(chosen);
          }}
          value={role}
        >
          {DIRECTORY_ROLES.map((choice) => (
            <option key={choice} value={choice}>
              {ROLE_LABELS[choice]}
            </option>
          ))}
        </NativeSelect>
      </Field>
    </ActionDialog>
  );
}

function CreateTokenDialog({
  onClose,
  organizationId,
}: Readonly<{ onClose: () => void; organizationId: string }>) {
  const queryClient = useQueryClient();
  const refresh = () => invalidateDirectory(queryClient, organizationId);
  return (
    <SecretActionDialog<DirectoryToken>
      confirmLabel="Create token"
      description="The token's secret is shown once, right after you create it. It will not be shown again."
      onClose={onClose}
      onIssued={() => void refresh()}
      onStored={() => void refresh()}
      open
      run={(idempotencyKey) =>
        refreshOnConflict(
          createDirectoryTokenFn({ data: { idempotencyKey, scope: { organizationId } } }),
          refresh,
        )
      }
      secretDescription={(token) => (
        <>
          Paste it into your identity provider as the SCIM bearer token. It starts with{" "}
          <Code>{token.tokenPrefix}</Code> and will not be shown again.
        </>
      )}
      secretLabel="SCIM token"
      successMessage="SCIM token created"
      title="Create a SCIM token"
    />
  );
}

function RevokeTokenDialog({
  directory,
  onClose,
  organizationId,
  token,
}: Readonly<{
  directory: DirectoryResponse;
  onClose: () => void;
  organizationId: string;
  token: DirectoryToken;
}>) {
  const queryClient = useQueryClient();
  const refresh = () => invalidateDirectory(queryClient, organizationId);
  return (
    <ActionDialog
      confirmLabel="Revoke token"
      confirmation={token.tokenPrefix}
      description={revokeConsequence(directory, token)}
      destructive
      onClose={onClose}
      onSuccess={() => void refresh()}
      open
      run={(idempotencyKey) =>
        refreshOnConflict(
          revokeDirectoryTokenFn({
            data: { id: token.id, idempotencyKey, scope: { organizationId } },
          }),
          refresh,
        )
      }
      successMessage="SCIM token revoked"
      title={`Revoke ${token.tokenPrefix}…?`}
    />
  );
}
