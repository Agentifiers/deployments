import type {
  WorkflowDefinitionResponse,
  WorkflowReleaseResponse,
} from "@deployments-ai/api-contract";
import { Archive02Icon, Edit02Icon, PlayIcon, Rocket01Icon } from "@hugeicons/core-free-icons";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { environmentQuery } from "../../data/console-queries.ts";
import {
  archiveDefinitionFn,
  archiveReleaseFn,
  createDefinitionFn,
  publishReleaseFn,
  startExecutionFn,
  updateDefinitionFn,
} from "../../data/workflow-mutations.ts";
import { invalidateWorkflows } from "../../data/workflow-queries.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import { Description, ErrorMessage, Field, Label } from "@/components/ui/field";
import { Code } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import {
  draftEditOf,
  parseJsonObject,
  prettyJson,
  type ParsedJsonObject,
} from "../../workflows/model.ts";
import { ActionDialog, refreshOnConflict, typedConfirmation } from "../action-dialog.tsx";
import { Icon } from "../icon.tsx";
import { useKeyedSnapshot } from "../keyed-snapshot.ts";

const STARTER_DEFINITION = {
  entryStepId: "review",
  name: "Approval gate",
  schemaVersion: 1,
  slug: "approval-gate",
  steps: [
    {
      id: "review",
      onApproved: "approved",
      onRejected: "rejected",
      prompt: "Approve this execution?",
      type: "approval",
    },
    { id: "approved", type: "end" },
    { id: "rejected", type: "end" },
  ],
};

function JsonField({
  description,
  label,
  onChange,
  parsed,
  rows,
  text,
}: Readonly<{
  description: ReactNode;
  label: string;
  onChange: (text: string) => void;
  parsed: ParsedJsonObject;
  rows: number;
  text: string;
}>) {
  return (
    <Field invalid={parsed.kind === "invalid"}>
      <Label>{label}</Label>
      <Description>{description}</Description>
      <Textarea
        className="font-mono"
        aria-invalid={parsed.kind === "invalid"}
        name={label}
        onChange={(event) => onChange(event.target.value)}
        rows={rows}
        spellCheck={false}
        value={text}
      />
      {parsed.kind === "invalid" ? <ErrorMessage>{parsed.message}</ErrorMessage> : null}
    </Field>
  );
}

const DEFINITION_HELP = (
  <>
    A <Code>WorkflowDefinitionDocumentV1</Code> document. The console checks it against the
    contract, including the step graph, before sending it.
  </>
);

/** Stays mounted while closed, so an unfinished document survives reopening. */
export function CreateDefinitionDialog({
  onClose,
  open,
  scope,
}: Readonly<{ onClose: () => void; open: boolean; scope: EnvironmentScope }>) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [text, setText] = useState(() => prettyJson(STARTER_DEFINITION));
  const parsed = parseJsonObject(text);
  return (
    <ActionDialog<{ readonly id: string }>
      confirmLabel="Create workflow"
      confirmation={typedConfirmation(environment.type, { phrase: "create workflow" })}
      description="The document becomes the definition's draft. Publish a release to run it."
      invalid={parsed.kind !== "object"}
      onClose={onClose}
      onSuccess={({ id }) => {
        setText(prettyJson(STARTER_DEFINITION));
        void invalidateWorkflows(queryClient, scope);
        void navigate({
          params: {
            definitionId: id,
            envId: scope.environmentId,
            orgId: scope.organizationId,
            projectId: scope.projectId,
          },
          to: "/o/$orgId/p/$projectId/e/$envId/workflows/$definitionId",
        });
      }}
      open={open}
      run={(idempotencyKey) =>
        createDefinitionFn({
          data: {
            document: parsed.kind === "object" ? parsed.value : {},
            idempotencyKey,
            scope,
          },
        })
      }
      size="3xl"
      successMessage="Workflow created"
      title="Create workflow"
    >
      <JsonField
        description={DEFINITION_HELP}
        label="Definition JSON"
        onChange={setText}
        parsed={parsed}
        rows={22}
        text={text}
      />
    </ActionDialog>
  );
}

export function EditDefinitionAction({
  definition,
  scope,
}: Readonly<{ definition: WorkflowDefinitionResponse; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState(() => draftEditOf(definition));
  const parsed = parseJsonObject(edit.text);
  const refresh = () => invalidateWorkflows(queryClient, scope);
  return (
    <>
      <Button
        onClick={() => {
          setEdit(draftEditOf(definition));
          setOpen(true);
        }}
        variant="outline"
      >
        <Icon icon={Edit02Icon} />
        Edit draft
      </Button>
      <ActionDialog
        confirmLabel="Save draft"
        confirmation={typedConfirmation(environment.type, { phrase: definition.slug })}
        description="Saving changes the draft only. Releases and running executions keep the document they were published with."
        invalid={parsed.kind !== "object"}
        onClose={() => setOpen(false)}
        onSuccess={() => void refresh()}
        open={open}
        run={(idempotencyKey) =>
          refreshOnConflict(
            updateDefinitionFn({
              data: {
                definitionId: definition.id,
                document: parsed.kind === "object" ? parsed.value : {},
                expectedVersion: edit.expectedVersion,
                idempotencyKey,
                scope,
              },
            }),
            refresh,
          )
        }
        size="3xl"
        successMessage="Draft saved"
        title={`Edit ${definition.name}`}
      >
        <JsonField
          description={DEFINITION_HELP}
          label="Definition JSON"
          onChange={(text) => setEdit((current) => ({ ...current, text }))}
          parsed={parsed}
          rows={22}
          text={edit.text}
        />
      </ActionDialog>
    </>
  );
}

export function PublishReleaseAction({
  definition,
  scope,
}: Readonly<{ definition: WorkflowDefinitionResponse; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const versionFor = useKeyedSnapshot<number>();
  const [open, setOpen] = useState(false);
  const refresh = () => invalidateWorkflows(queryClient, scope);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Icon icon={Rocket01Icon} />
        Publish release
      </Button>
      <ActionDialog
        confirmLabel="Publish"
        confirmation={typedConfirmation(environment.type, { live: true, phrase: definition.slug })}
        description={`Publishes draft version ${definition.version} as a new numbered release. The release is immutable, and new executions can start from it.`}
        onClose={() => setOpen(false)}
        onSuccess={() => void refresh()}
        open={open}
        run={(idempotencyKey, resend) =>
          refreshOnConflict(
            publishReleaseFn({
              data: {
                definitionId: definition.id,
                expectedDefinitionVersion: versionFor(idempotencyKey, resend, definition.version),
                idempotencyKey,
                scope,
              },
            }),
            refresh,
          )
        }
        successMessage={({ releaseNumber }) => `Release #${releaseNumber} published`}
        title={`Publish ${definition.name}`}
      />
    </>
  );
}

export function ArchiveDefinitionAction({
  definition,
  scope,
}: Readonly<{ definition: WorkflowDefinitionResponse; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const expectedVersionFor = useKeyedSnapshot<number>();
  const [open, setOpen] = useState(false);
  const refresh = () => invalidateWorkflows(queryClient, scope);
  return (
    <>
      <Button variant="destructive" onClick={() => setOpen(true)}>
        <Icon icon={Archive02Icon} />
        Archive
      </Button>
      <ActionDialog
        confirmLabel="Archive workflow"
        confirmation={definition.slug}
        description="An archived definition cannot be edited or published, and it cannot be restored. Its active releases can still start executions, so archive them separately."
        destructive
        onClose={() => setOpen(false)}
        onSuccess={() => void refresh()}
        open={open}
        run={(idempotencyKey, resend) =>
          refreshOnConflict(
            archiveDefinitionFn({
              data: {
                definitionId: definition.id,
                expectedVersion: expectedVersionFor(idempotencyKey, resend, definition.version),
                idempotencyKey,
                scope,
              },
            }),
            refresh,
          )
        }
        successMessage="Workflow archived"
        title={`Archive ${definition.name}`}
      />
    </>
  );
}

export function ArchiveReleaseAction({
  release,
  scope,
}: Readonly<{ release: WorkflowReleaseResponse; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const expectedVersionFor = useKeyedSnapshot<number>();
  const [open, setOpen] = useState(false);
  const refresh = () => invalidateWorkflows(queryClient, scope);
  return (
    <>
      <Button variant="destructive" onClick={() => setOpen(true)}>
        <Icon icon={Archive02Icon} />
        Archive
      </Button>
      <ActionDialog
        confirmLabel="Archive release"
        confirmation={`release ${release.releaseNumber}`}
        description="New executions cannot start from an archived release, and it cannot be restored."
        destructive
        onClose={() => setOpen(false)}
        onSuccess={() => void refresh()}
        open={open}
        run={(idempotencyKey, resend) =>
          refreshOnConflict(
            archiveReleaseFn({
              data: {
                expectedVersion: expectedVersionFor(idempotencyKey, resend, release.version),
                idempotencyKey,
                releaseId: release.id,
                scope,
              },
            }),
            refresh,
          )
        }
        successMessage={`Release #${release.releaseNumber} archived`}
        title={`Archive release #${release.releaseNumber}`}
      />
    </>
  );
}

export function StartExecutionAction({
  release,
  scope,
}: Readonly<{ release: WorkflowReleaseResponse; scope: EnvironmentScope }>) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const parsed = parseJsonObject(text);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Icon icon={PlayIcon} />
        Start execution
      </Button>
      <ActionDialog<{ readonly id: string }>
        confirmLabel="Start"
        confirmation={typedConfirmation(environment.type, { live: true, phrase: "start" })}
        description={`Starts release #${release.releaseNumber} of ${release.definition.name}. Agent, tool, and notification steps act for real and can incur cost.`}
        invalid={parsed.kind === "invalid"}
        onClose={() => setOpen(false)}
        onSuccess={({ id }) => {
          setText("");
          void invalidateWorkflows(queryClient, scope);
          void navigate({
            params: {
              envId: scope.environmentId,
              executionId: id,
              orgId: scope.organizationId,
              projectId: scope.projectId,
            },
            to: "/o/$orgId/p/$projectId/e/$envId/workflows/executions/$executionId",
          });
        }}
        open={open}
        run={(idempotencyKey) =>
          startExecutionFn({
            data: {
              idempotencyKey,
              releaseId: release.id,
              scope,
              ...(parsed.kind === "object" ? { input: parsed.value } : {}),
            },
          })
        }
        size="2xl"
        successMessage="Execution started"
        title={`Start ${release.definition.name} #${release.releaseNumber}`}
      >
        <JsonField
          description="Optional. A JSON object the steps read as the execution's input."
          label="Input JSON"
          onChange={setText}
          parsed={parsed}
          rows={8}
          text={text}
        />
      </ActionDialog>
    </>
  );
}
