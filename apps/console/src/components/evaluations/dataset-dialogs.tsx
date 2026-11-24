import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { environmentQuery } from "../../data/console-queries.ts";
import {
  archiveRegressionDataset,
  createRegressionDataset,
  importDatasetCases,
} from "../../data/evaluation-mutations.ts";
import { invalidateEvaluations } from "../../data/evaluation-queries.ts";
import { optionalNumber, parseCaseFile } from "../../evaluations/requests.ts";
import type { EnvironmentScope } from "../../scope.ts";
import type { RegressionDataset } from "../../server/evaluation-data.ts";
import { Description, Field, Label } from "@/components/ui/field";
import { FileInput } from "@/components/ui/file-input";
import { Input } from "@/components/ui/input";
import { Code, Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";

/** Evaluation resource names: lowercase letters, digits, `.`, `_`, `-`; up to 64 characters. */
export const RESOURCE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const MAX_CASE_FILE_BYTES = 1_048_576;
const CASE_FILE_EXAMPLE = `[
  { "id": "refund-1", "message": "Where is my refund?", "expected": { "mustInclude": ["refund"] } }
]`;

export function ResourceNameField({
  label,
  onChange,
  value,
}: Readonly<{ label: string; onChange: (value: string) => void; value: string }>) {
  return (
    <Field>
      <Label>{label}</Label>
      <Description>Lowercase letters, digits, ".", "_", or "-"; up to 64 characters.</Description>
      <Input
        autoComplete="off"
        aria-invalid={value !== "" && !RESOURCE_NAME.test(value)}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
    </Field>
  );
}

/** Creates an empty regression dataset, then opens it so cases can be imported. */
export function CreateDatasetDialog({
  onClose,
  open,
  scope,
}: Readonly<{ onClose: () => void; open: boolean; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [retention, setRetention] = useState("");
  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setRetention("");
  }, [open]);
  const retentionDays = optionalNumber(retention, "Retention");
  const invalid = !RESOURCE_NAME.test(name) || !retentionDays.ok;

  return (
    <ActionDialog
      confirmLabel="Create dataset"
      confirmation={typedConfirmation(environment.type, { phrase: name || "create" })}
      description="A dataset holds replayable cases. Import cases after it is created."
      invalid={invalid}
      onClose={onClose}
      onSuccess={(dataset) => {
        void invalidateEvaluations(queryClient, scope);
        void navigate({
          params: {
            datasetId: dataset.id,
            envId: scope.environmentId,
            orgId: scope.organizationId,
            projectId: scope.projectId,
          },
          to: "/o/$orgId/p/$projectId/e/$envId/evaluations/datasets/$datasetId",
        });
      }}
      open={open}
      run={(idempotencyKey: string) =>
        createRegressionDataset({
          data: {
            body: {
              name,
              ...(description.trim() ? { description: description.trim() } : {}),
              ...(retentionDays.ok && retentionDays.value !== undefined
                ? { retentionDays: retentionDays.value }
                : {}),
            },
            idempotencyKey,
            scope,
          },
        })
      }
      successMessage="Dataset created"
      title="Create dataset"
    >
      <ResourceNameField label="Name" onChange={setName} value={name} />
      <Field>
        <Label>Description</Label>
        <Textarea
          onChange={(event) => setDescription(event.target.value)}
          resizable={false}
          rows={2}
          value={description}
        />
      </Field>
      <Field>
        <Label>Retention days</Label>
        <Description>Optional. Days to retain captured cases (1–3650).</Description>
        <Input
          inputMode="numeric"
          aria-invalid={!retentionDays.ok}
          onChange={(event) => setRetention(event.target.value)}
          value={retention}
        />
      </Field>
    </ActionDialog>
  );
}

/**
 * Imports up to 100 cases from a JSON case file (pasted or uploaded). The server checks every
 * case against the contract; cases whose content already exists are reported, not duplicated.
 */
export function ImportCasesDialog({
  dataset,
  onClose,
  open,
  scope,
}: Readonly<{
  dataset: RegressionDataset;
  onClose: () => void;
  open: boolean;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [text, setText] = useState("");
  const [files, setFiles] = useState<readonly File[]>([]);
  const [fileError, setFileError] = useState<string>();
  useEffect(() => {
    if (!open) return;
    setText("");
    setFiles([]);
    setFileError(undefined);
  }, [open]);
  const cases = parseCaseFile(text);

  const upload = (selected: File[]) => {
    setFiles(selected);
    setFileError(undefined);
    const [file] = selected;
    if (file) void file.text().then(setText);
  };

  return (
    <ActionDialog
      confirmLabel="Import cases"
      confirmation={typedConfirmation(environment.type, { phrase: dataset.name })}
      description={
        <>
          Into <Code>{dataset.name}</Code>. A JSON array of cases: <Code>message</Code> is the user
          input; <Code>expected</Code> holds <Code>mustInclude</Code>, <Code>mustNot</Code>,{" "}
          <Code>mustUseTools</Code>, <Code>mustNotUseTools</Code>, <Code>matches</Code>, or{" "}
          <Code>jsonSchema</Code>.
        </>
      }
      invalid={!cases.ok}
      onClose={onClose}
      onSuccess={(result) => {
        void invalidateEvaluations(queryClient, scope);
        toast.success(`${result.created} created, ${result.existing} already present`);
      }}
      open={open}
      run={(idempotencyKey: string) => {
        if (!cases.ok) throw new TypeError(cases.error);
        return importDatasetCases({
          data: { body: { cases: cases.value }, datasetId: dataset.id, idempotencyKey, scope },
        });
      }}
      size="2xl"
      successMessage="Cases imported"
      title="Import cases"
    >
      <Field>
        <Label>Case file</Label>
        <FileInput
          accept=".json,application/json"
          maxSize={MAX_CASE_FILE_BYTES}
          onChange={upload}
          onReject={() => setFileError("Choose a JSON file of at most 1 MB.")}
          value={files}
        />
        {fileError ? <Text className="text-destructive">{fileError}</Text> : null}
      </Field>
      <Field>
        <Label>Cases (JSON)</Label>
        <Textarea
          className="font-mono"
          onChange={(event) => setText(event.target.value)}
          placeholder={CASE_FILE_EXAMPLE}
          rows={10}
          value={text}
        />
        {text && !cases.ok ? <Description>{cases.error}</Description> : null}
      </Field>
    </ActionDialog>
  );
}

/** Archives a dataset: it keeps its cases and history but accepts no new cases or runs. */
export function ArchiveDatasetDialog({
  dataset,
  onClose,
  open,
  scope,
}: Readonly<{
  dataset: RegressionDataset;
  onClose: () => void;
  open: boolean;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  return (
    <ActionDialog
      confirmLabel="Archive dataset"
      confirmation={typedConfirmation(environment.type, {
        destructive: true,
        phrase: dataset.name,
      })}
      description="Archived datasets keep their cases and past results but accept no new cases, and new evaluation runs cannot replay them. Archiving cannot be undone."
      destructive
      onClose={onClose}
      onSuccess={() => void invalidateEvaluations(queryClient, scope)}
      open={open}
      run={(idempotencyKey: string) =>
        archiveRegressionDataset({ data: { datasetId: dataset.id, idempotencyKey, scope } })
      }
      successMessage="Dataset archived"
      title={`Archive ${dataset.name}?`}
    />
  );
}
