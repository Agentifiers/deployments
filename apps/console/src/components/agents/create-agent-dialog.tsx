import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { checkDraft, draftText, MANIFEST_TEMPLATE } from "../../agents/manifest-draft.ts";
import { createAgentDefinitionFn } from "../../data/agent-mutations.ts";
import { invalidateAgent } from "../../data/agent-queries.ts";
import { workspacesQuery } from "../../data/connection-queries.ts";
import type { EnvironmentScope } from "../../scope.ts";
import type { EnvironmentSummary } from "../../server/console-data.ts";
import { Description, Field, Label } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";
import { ManifestEditor } from "./manifest-editor.tsx";

/** No workspace: the definition is shared by the whole environment. */
const SHARED = "";

/**
 * Lists the environment's active workspaces when the caller may read them. With none to pick,
 * including while they load, it shows nothing and the agent is shared by the environment.
 */
function WorkspaceField({
  canListWorkspaces,
  onChange,
  scope,
  value,
}: Readonly<{
  canListWorkspaces: boolean;
  onChange: (workspaceId: string) => void;
  scope: EnvironmentScope;
  value: string;
}>) {
  const workspaces = useQuery({ ...workspacesQuery(scope), enabled: canListWorkspaces });
  const active = (workspaces.data ?? []).filter((workspace) => workspace.status === "active");
  if (!canListWorkspaces || (active.length === 0 && !workspaces.isError)) return null;
  return (
    <Field>
      <Label>Workspace</Label>
      <NativeSelect
        name="workspaceId"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value={SHARED}>None, shared by the environment</option>
        {active.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {workspace.name}
          </option>
        ))}
      </NativeSelect>
      <Description>
        {workspaces.isError
          ? "Workspaces failed to load; the agent can still be shared by the environment."
          : "A workspace-owned agent's key must be unique in that workspace. Set only at creation."}
      </Description>
    </Field>
  );
}

/**
 * Creates an agent definition from the manifest editor, starting from a minimal template. Mount it
 * only while open: an abandoned draft does not carry over, so each opening starts from the
 * template.
 */
export function CreateAgentDefinitionDialog({
  canListWorkspaces,
  environmentType,
  onClose,
  scope,
}: Readonly<{
  canListWorkspaces: boolean;
  environmentType: EnvironmentSummary["type"];
  onClose: () => void;
  scope: EnvironmentScope;
}>) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const template = useMemo(() => draftText(MANIFEST_TEMPLATE), []);
  const [text, setText] = useState(template);
  const [workspaceId, setWorkspaceId] = useState(SHARED);
  const check = useMemo(() => checkDraft(text), [text]);

  return (
    <ActionDialog
      confirmLabel="Create agent"
      confirmation={typedConfirmation(environmentType, { phrase: "create agent" })}
      description="The manifest becomes the agent's draft. Publish a release to deploy it."
      dirty={text !== template || workspaceId !== SHARED}
      invalid={check.kind !== "valid"}
      onClose={onClose}
      onSuccess={(definition) => {
        void navigate({
          params: {
            definitionId: definition.id,
            envId: scope.environmentId,
            orgId: scope.organizationId,
            projectId: scope.projectId,
          },
          to: "/o/$orgId/p/$projectId/e/$envId/agents/$definitionId/configuration",
        });
        void invalidateAgent(queryClient, scope, definition.id);
      }}
      open
      run={(idempotencyKey: string) =>
        createAgentDefinitionFn({
          data: {
            body: {
              manifest: check.kind === "valid" ? check.manifest : MANIFEST_TEMPLATE,
              ...(workspaceId === SHARED ? {} : { workspaceId }),
            },
            idempotencyKey,
            scope,
          },
        })
      }
      size="3xl"
      successMessage="Agent created"
      title="Create agent"
    >
      <WorkspaceField
        canListWorkspaces={canListWorkspaces}
        onChange={setWorkspaceId}
        scope={scope}
        value={workspaceId}
      />
      <ManifestEditor check={check} layout="create" onText={setText} text={text} />
    </ActionDialog>
  );
}
