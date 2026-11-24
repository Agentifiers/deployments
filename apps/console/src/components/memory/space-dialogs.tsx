import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { workspacesQuery } from "../../data/connection-queries.ts";
import { environmentQuery } from "../../data/console-queries.ts";
import { archiveSpaceFn, createSpaceFn } from "../../data/memory-mutations.ts";
import { invalidateMemory } from "../../data/memory-queries.ts";
import { spaceRequest, type MemorySpace, type SpaceDraft } from "../../memory/model.ts";
import { oneOf } from "../../observability/range.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Description, ErrorMessage, Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { TextLink } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";

export const SPACE_KIND_LABELS: Readonly<Record<MemorySpace["kind"], string>> = {
  agent: "Agent",
  organization: "Organization",
  shared: "Shared",
  workspace: "Workspace",
};
const CREATABLE_KINDS = [
  "workspace",
  "organization",
  "shared",
  "agent",
] as const satisfies readonly MemorySpace["kind"][];

const EMPTY_DRAFT: SpaceDraft = {
  description: "",
  kind: "workspace",
  name: "",
  retentionDays: "",
  workspaceId: "",
};

export function CreateSpaceDialog({
  onClose,
  open,
  scope,
}: Readonly<{ onClose: () => void; open: boolean; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const workspaces = useQuery({ ...workspacesQuery(scope), enabled: open });
  const activeWorkspaces = (workspaces.data ?? []).filter(
    (workspace) => workspace.status === "active",
  );
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  useEffect(() => {
    if (open) setDraft(EMPTY_DRAFT);
  }, [open]);
  const parsed = spaceRequest(draft);
  const touched = draft.name !== "" || draft.retentionDays !== "" || draft.description !== "";

  return (
    <ActionDialog<MemorySpace>
      confirmLabel="Create space"
      confirmation={typedConfirmation(environment.type, { phrase: draft.name.trim() || "create" })}
      description="Agents read and write a space only through a grant. A space can be archived later but never renamed or deleted."
      invalid={!parsed.ok}
      onClose={onClose}
      onSuccess={(space) => {
        void invalidateMemory(queryClient, scope);
        void navigate({
          params: {
            envId: scope.environmentId,
            orgId: scope.organizationId,
            projectId: scope.projectId,
            spaceId: space.id,
          },
          to: "/o/$orgId/p/$projectId/e/$envId/memory/spaces/$spaceId",
        });
      }}
      open={open}
      run={(idempotencyKey) => {
        if (!parsed.ok) throw new TypeError(parsed.problem);
        return createSpaceFn({ data: { body: parsed.request, idempotencyKey, scope } });
      }}
      successMessage={(space) => `Memory space ${space.name} created`}
      title="Create memory space"
    >
      <Field>
        <Label>Name</Label>
        <Input
          autoComplete="off"
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          value={draft.name}
        />
      </Field>
      <Field>
        <Label>Description</Label>
        <Textarea
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          rows={2}
          value={draft.description}
        />
      </Field>
      <Field>
        <Label>Kind</Label>
        <Description>
          An agent whose manifest sets a memory mode reads and writes only a space of that kind it
          holds a grant on: a workspace-memory agent needs a workspace space.
        </Description>
        <NativeSelect
          onChange={(event) => {
            const kind = oneOf(CREATABLE_KINDS, event.target.value);
            if (kind) setDraft({ ...draft, kind });
          }}
          value={draft.kind}
        >
          {CREATABLE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {SPACE_KIND_LABELS[kind]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {draft.kind === "workspace" ? (
        <Field disabled={workspaces.isPending}>
          <Label>Workspace</Label>
          {workspaces.isSuccess && activeWorkspaces.length === 0 ? (
            <Description>
              This environment has no active workspace.{" "}
              <TextLink href={`${environmentPath(scope)}/workspaces`}>Create one first</TextLink>.
            </Description>
          ) : null}
          <NativeSelect
            onChange={(event) => setDraft({ ...draft, workspaceId: event.target.value })}
            value={draft.workspaceId}
          >
            <option value="">
              {workspaces.isPending ? "Loading workspaces…" : "Choose a workspace"}
            </option>
            {activeWorkspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name} ({workspace.slug})
              </option>
            ))}
          </NativeSelect>
        </Field>
      ) : null}
      <Field>
        <Label>Retention in days</Label>
        <Description>
          Optional, 1 to 3650. A memory policy's retention, when set, takes its place.
        </Description>
        <Input
          autoComplete="off"
          inputMode="numeric"
          onChange={(event) => setDraft({ ...draft, retentionDays: event.target.value })}
          value={draft.retentionDays}
        />
      </Field>
      {touched && !parsed.ok ? <ErrorMessage>{parsed.problem}</ErrorMessage> : null}
    </ActionDialog>
  );
}

export function ArchiveSpaceDialog({
  onClose,
  open,
  scope,
  space,
}: Readonly<{ onClose: () => void; open: boolean; scope: EnvironmentScope; space: MemorySpace }>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  return (
    <ActionDialog<MemorySpace>
      confirmLabel="Archive space"
      confirmation={typedConfirmation(environment.type, { destructive: true, phrase: space.name })}
      description="Archiving is permanent: there is no unarchive. An archived space refuses imports, new grants, restores, and searches. Its memories stay stored."
      destructive
      onClose={onClose}
      onSuccess={() => void invalidateMemory(queryClient, scope)}
      open={open}
      run={(idempotencyKey) =>
        archiveSpaceFn({ data: { idempotencyKey, memorySpaceId: space.id, scope } })
      }
      successMessage={`Memory space ${space.name} archived`}
      title={`Archive ${space.name}?`}
    />
  );
}
