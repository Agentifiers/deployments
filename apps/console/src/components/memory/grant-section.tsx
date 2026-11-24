import { PlusSignIcon, Robot01Icon } from "@hugeicons/core-free-icons";
import { useQueryClient, useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { agentListQuery } from "../../data/agent-queries.ts";
import { environmentQuery, organizationShellQuery } from "../../data/console-queries.ts";
import { createGrantFn, revokeGrantFn, updateGrantFn } from "../../data/memory-mutations.ts";
import { grantPagesQuery, invalidateMemory } from "../../data/memory-queries.ts";
import { GRANT_EMPTY_TITLES } from "../../memory/copy.ts";
import {
  GRANT_FILTERS,
  GRANT_PERMISSIONS,
  type GrantFilter,
  type GrantPermission,
  type MemorySpace,
  type MemorySpaceGrant,
} from "../../memory/model.ts";
import { oneOf } from "../../observability/range.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
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
import { Text, TextLink } from "@/components/ui/text";
import { SingleToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";
import { Icon } from "../icon.tsx";
import { ListEmpty, LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { StatusBadge } from "@/components/status-badge";

const FILTER_LABELS: Readonly<Record<GrantFilter, string>> = {
  active: "Active",
  all: "All",
  revoked: "Revoked",
};

const PERMISSION_COPY: Readonly<Record<GrantPermission, string>> = {
  read: "Read: the agent searches and recalls this space.",
  "read-write": "Read and write: the agent also saves memories to this space.",
};

type GrantDialog =
  | { readonly kind: "create" }
  | { readonly grant: MemorySpaceGrant; readonly kind: "permission" | "revoke" };

function useAgentNames(scope: EnvironmentScope): ReadonlyMap<string, string> {
  const { data } = useSuspenseQuery(agentListQuery(scope, true));
  return new Map(data.rows.map(({ definition }) => [definition.id, definition.name]));
}

function PermissionSelect({
  onChange,
  value,
}: Readonly<{ onChange: (permission: GrantPermission) => void; value: GrantPermission }>) {
  return (
    <Field>
      <Label>Permission</Label>
      <Description>{PERMISSION_COPY[value]}</Description>
      <NativeSelect
        onChange={(event) => {
          const permission = oneOf(GRANT_PERMISSIONS, event.target.value);
          if (permission) onChange(permission);
        }}
        value={value}
      >
        {GRANT_PERMISSIONS.map((permission) => (
          <option key={permission} value={permission}>
            {permission}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}

export function GrantSection({
  filter,
  onFilter,
  scope,
  space,
}: Readonly<{
  filter: GrantFilter;
  onFilter: (filter: GrantFilter) => void;
  scope: EnvironmentScope;
  space: MemorySpace;
}>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const [dialog, setDialog] = useState<GrantDialog>();
  const { access } = shell;
  const close = () => setDialog(undefined);
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Subheading>Agent grants</Subheading>
        <SingleToggleGroup
          aria-label="Grants shown"
          onValueChange={(next) => {
            const known = oneOf(GRANT_FILTERS, next);
            if (known) onFilter(known);
          }}
          size="sm"
          value={filter}
        >
          {GRANT_FILTERS.map((option) => (
            <ToggleGroupItem key={option} value={option}>
              {FILTER_LABELS[option]}
            </ToggleGroupItem>
          ))}
        </SingleToggleGroup>
        {access.createMemorySpaceGrant && space.status === "active" ? (
          <Button
            className="ml-auto"
            onClick={() => setDialog({ kind: "create" })}
            variant="outline"
          >
            <Icon icon={PlusSignIcon} />
            Grant an agent
          </Button>
        ) : null}
      </div>
      <SectionBoundary resetKey={filter}>
        <GrantTable filter={filter} onAction={setDialog} scope={scope} space={space} />
      </SectionBoundary>
      {dialog?.kind === "create" ? (
        <CreateGrantDialog onClose={close} scope={scope} space={space} />
      ) : null}
      {dialog?.kind === "permission" ? (
        <PermissionDialog grant={dialog.grant} onClose={close} scope={scope} />
      ) : null}
      {dialog?.kind === "revoke" ? (
        <RevokeGrantDialog grant={dialog.grant} onClose={close} scope={scope} />
      ) : null}
    </section>
  );
}

function GrantTable({
  filter,
  onAction,
  scope,
  space,
}: Readonly<{
  filter: GrantFilter;
  onAction: (dialog: GrantDialog) => void;
  scope: EnvironmentScope;
  space: MemorySpace;
}>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const pagesQuery = grantPagesQuery(scope, space.id, filter);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const names = useAgentNames(scope);
  const grants = data.pages.flatMap((page) => page.items);
  const { access } = shell;
  if (grants.length === 0) {
    return (
      <ListEmpty
        docs="/docs/capabilities/memory"
        icon={Robot01Icon}
        title={GRANT_EMPTY_TITLES[filter]}
      >
        An agent reads or writes this space only while it holds a grant.
      </ListEmpty>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <Table striped>
        <TableHeader>
          <TableRow>
            <TableHead>Agent</TableHead>
            <TableHead>Permission</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Granted</TableHead>
            <TableHead>ID</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {grants.map((grant) => (
            <TableRow key={grant.id}>
              <TableCell>
                <TextLink href={`${environmentPath(scope)}/agents/${grant.agentDefinitionId}`}>
                  {names.get(grant.agentDefinitionId) ?? "Unknown agent"}
                </TextLink>
                <div>
                  <PublicId value={grant.agentDefinitionId} />
                </div>
              </TableCell>
              <TableCell>{grant.permission}</TableCell>
              <TableCell>
                <StatusBadge status={grant.status} />
                {grant.status === "revoked" ? (
                  <div className="text-xs/5 text-muted-foreground">
                    <Timestamp value={grant.revokedAt} />
                  </div>
                ) : null}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <Timestamp value={grant.createdAt} />
              </TableCell>
              <TableCell>
                <PublicId value={grant.id} />
              </TableCell>
              <TableCell>
                {grant.status === "active" ? (
                  <div className="flex justify-end gap-2">
                    {access.updateMemorySpaceGrant ? (
                      <Button
                        onClick={() => onAction({ grant, kind: "permission" })}
                        variant="outline"
                      >
                        Change permission
                      </Button>
                    ) : null}
                    {access.revokeMemorySpaceGrant ? (
                      <Button
                        variant="destructive"
                        onClick={() => onAction({ grant, kind: "revoke" })}
                      >
                        Revoke
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <LoadMore
        error={error}
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        queryKey={pagesQuery.queryKey}
      />
    </div>
  );
}

function CreateGrantDialog({
  onClose,
  scope,
  space,
}: Readonly<{ onClose: () => void; scope: EnvironmentScope; space: MemorySpace }>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const { data: agents } = useSuspenseQuery(agentListQuery(scope, true));
  const definitions = agents.rows
    .map((row) => row.definition)
    .filter((definition) => definition.status === "active");
  const [agentDefinitionId, setAgentDefinitionId] = useState(definitions[0]?.id ?? "");
  const [permission, setPermission] = useState<GrantPermission>("read");
  const agentName = definitions.find((definition) => definition.id === agentDefinitionId)?.name;

  return (
    <ActionDialog<MemorySpaceGrant>
      confirmLabel="Grant"
      confirmation={typedConfirmation(environment.type, { phrase: agentName ?? "grant" })}
      description="If the agent already holds an active grant on this space, the platform changes that grant's permission instead of adding one."
      invalid={agentName === undefined}
      onClose={onClose}
      onSuccess={() => void invalidateMemory(queryClient, scope)}
      open
      run={(idempotencyKey) =>
        createGrantFn({
          data: {
            body: { agentDefinitionId, memorySpaceId: space.id, permission },
            idempotencyKey,
            scope,
          },
        })
      }
      successMessage={`${agentName ?? "Agent"} granted ${permission} on ${space.name}`}
      title={`Grant an agent access to ${space.name}`}
    >
      {definitions.length === 0 ? (
        <Text>This environment has no active agents. Create an agent first.</Text>
      ) : (
        <Field>
          <Label>Agent</Label>
          <NativeSelect
            onChange={(event) => setAgentDefinitionId(event.target.value)}
            value={agentDefinitionId}
          >
            {definitions.map((definition) => (
              <option key={definition.id} value={definition.id}>
                {definition.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
      )}
      <PermissionSelect onChange={setPermission} value={permission} />
    </ActionDialog>
  );
}

function PermissionDialog({
  grant,
  onClose,
  scope,
}: Readonly<{ grant: MemorySpaceGrant; onClose: () => void; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const names = useAgentNames(scope);
  const agentName = names.get(grant.agentDefinitionId) ?? grant.agentDefinitionId;
  const [permission, setPermission] = useState<GrantPermission>(
    grant.permission === "read" ? "read-write" : "read",
  );
  return (
    <ActionDialog<MemorySpaceGrant>
      confirmLabel="Change permission"
      confirmation={typedConfirmation(environment.type, { phrase: agentName })}
      invalid={permission === grant.permission}
      onClose={onClose}
      onSuccess={() => void invalidateMemory(queryClient, scope)}
      open
      run={(idempotencyKey) =>
        updateGrantFn({ data: { grantId: grant.id, idempotencyKey, permission, scope } })
      }
      successMessage={`${agentName} now has ${permission}`}
      title={`Change ${agentName}'s permission`}
    >
      <PermissionSelect onChange={setPermission} value={permission} />
    </ActionDialog>
  );
}

function RevokeGrantDialog({
  grant,
  onClose,
  scope,
}: Readonly<{ grant: MemorySpaceGrant; onClose: () => void; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const names = useAgentNames(scope);
  const agentName = names.get(grant.agentDefinitionId) ?? grant.agentDefinitionId;
  return (
    <ActionDialog<MemorySpaceGrant>
      confirmLabel="Revoke grant"
      confirmation={typedConfirmation(environment.type, { destructive: true, phrase: agentName })}
      description="The agent loses access to this space. A revoked grant cannot be restored; granting again creates a new grant."
      destructive
      onClose={onClose}
      onSuccess={() => void invalidateMemory(queryClient, scope)}
      open
      run={(idempotencyKey) =>
        revokeGrantFn({ data: { grantId: grant.id, idempotencyKey, scope } })
      }
      successMessage={`Revoked ${agentName}'s grant`}
      title={`Revoke ${agentName}'s grant?`}
    />
  );
}
