import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { environmentQuery } from "../../data/console-queries.ts";
import { createScoreDefinition, reviseScoreDefinition } from "../../data/evaluation-mutations.ts";
import { invalidateEvaluations } from "../../data/evaluation-queries.ts";
import {
  EVALUATOR_TEMPLATES,
  jsonObject,
  scorerConfiguration,
  type EvaluatorKind,
  type ScorerConfigurationForm,
} from "../../evaluations/requests.ts";
import type { EnvironmentScope } from "../../scope.ts";
import type { ScoreDefinition } from "../../server/evaluation-data.ts";
import { Description, Field, Label } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { Code, Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";
import { RESOURCE_NAME, ResourceNameField } from "./dataset-dialogs.tsx";
import { NumberField } from "./pickers.tsx";

const EVALUATOR_KINDS = Object.keys(EVALUATOR_TEMPLATES) as EvaluatorKind[];

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

function emptyConfiguration(): ScorerConfigurationForm {
  return {
    evaluator: pretty(EVALUATOR_TEMPLATES.contains),
    samplingRate: "",
    target: "",
    threshold: "",
    weight: "",
  };
}

/** The current revision's configuration, so a revision changes only what the user edits. */
function currentConfiguration(scorer: ScoreDefinition): ScorerConfigurationForm {
  const { revision } = scorer;
  return {
    evaluator: revision.evaluator.json,
    samplingRate: String(revision.sampling.rate),
    target: revision.target,
    threshold: String(revision.threshold),
    weight: revision.weight === undefined ? "" : String(revision.weight),
  };
}

/** Evaluator, target, threshold, sampling, and weight: shared by create and revise. */
function ScorerConfigurationFields({
  form,
  onChange,
}: Readonly<{
  form: ScorerConfigurationForm;
  onChange: (patch: Partial<ScorerConfigurationForm>) => void;
}>) {
  const parsed = jsonObject(form.evaluator, "The evaluator");
  const evaluatorKind = parsed.ok
    ? EVALUATOR_KINDS.find((kind) => kind === parsed.value.kind)
    : undefined;
  return (
    <>
      <Field>
        <Label>Evaluator</Label>
        <Description>
          Choosing a kind replaces the configuration with a starting point. Values a case supplies
          (such as <Code>mustInclude</Code>) apply when the configuration leaves them out.
        </Description>
        <NativeSelect
          onChange={(event) => {
            const kind = EVALUATOR_KINDS.find((candidate) => candidate === event.target.value);
            if (kind) onChange({ evaluator: pretty(EVALUATOR_TEMPLATES[kind]) });
          }}
          value={evaluatorKind ?? ""}
        >
          <option disabled value="">
            Custom
          </option>
          {EVALUATOR_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field>
        <Label>Evaluator configuration (JSON)</Label>
        <Textarea
          className="font-mono"
          onChange={(event) => onChange({ evaluator: event.target.value })}
          rows={8}
          value={form.evaluator}
        />
      </Field>
      <Field>
        <Label>Target</Label>
        <NativeSelect
          onChange={(event) => {
            const target = event.target.value;
            onChange({ target: target === "root-run" || target === "trace" ? target : "" });
          }}
          value={form.target}
        >
          <option value="">Default (root run)</option>
          <option value="root-run">Root run only</option>
          <option value="trace">Every run in the trace</option>
        </NativeSelect>
      </Field>
      <div className="grid gap-6 sm:grid-cols-3">
        <NumberField
          description="Minimum passing value, 0–1."
          label="Threshold"
          onChange={(threshold) => onChange({ threshold })}
          placeholder="1"
          value={form.threshold}
        />
        <NumberField
          description="Share of finalized customer traces scored automatically, 0–1 (model judges at most 0.25)."
          label="Sampling rate"
          onChange={(samplingRate) => onChange({ samplingRate })}
          placeholder="0"
          value={form.samplingRate}
        />
        <NumberField
          description="Relative weight, above 0 and at most 100."
          label="Weight"
          onChange={(weight) => onChange({ weight })}
          placeholder="Default"
          value={form.weight}
        />
      </div>
    </>
  );
}

export function CreateScorerDialog({
  onClose,
  open,
  scope,
}: Readonly<{ onClose: () => void; open: boolean; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [form, setForm] = useState(emptyConfiguration);
  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setForm(emptyConfiguration());
  }, [open]);
  const configuration = scorerConfiguration(form);

  return (
    <ActionDialog
      confirmLabel="Create scorer"
      confirmation={typedConfirmation(environment.type, { phrase: name || "create" })}
      description="A score definition: how to score a response and what counts as passing. Each change becomes a new revision."
      invalid={!RESOURCE_NAME.test(name) || !configuration.ok}
      onClose={onClose}
      onSuccess={(scorer) => {
        void invalidateEvaluations(queryClient, scope);
        void navigate({
          params: {
            envId: scope.environmentId,
            orgId: scope.organizationId,
            projectId: scope.projectId,
            scoreDefinitionId: scorer.id,
          },
          to: "/o/$orgId/p/$projectId/e/$envId/evaluations/scorers/$scoreDefinitionId",
        });
      }}
      open={open}
      run={(idempotencyKey: string) => {
        if (!configuration.ok) throw new TypeError(configuration.error);
        return createScoreDefinition({
          data: {
            body: {
              ...configuration.value,
              name,
              ...(description.trim() ? { description: description.trim() } : {}),
            },
            idempotencyKey,
            scope,
          },
        });
      }}
      size="2xl"
      successMessage="Scorer created"
      title="Create scorer"
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
      <ScorerConfigurationFields
        form={form}
        onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
      />
      {configuration.ok ? null : <Text>{configuration.error}</Text>}
    </ActionDialog>
  );
}

/**
 * Creates the scorer's next revision from its current one. `expectedRevision` makes a concurrent
 * revision fail with a conflict instead of silently overwriting it.
 */
export function ReviseScorerDialog({
  onClose,
  open,
  scope,
  scorer,
}: Readonly<{
  onClose: () => void;
  open: boolean;
  scope: EnvironmentScope;
  scorer: ScoreDefinition;
}>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [form, setForm] = useState(() => currentConfiguration(scorer));
  useEffect(() => {
    if (open) setForm(currentConfiguration(scorer));
  }, [open, scorer]);
  const configuration = scorerConfiguration(form);

  return (
    <ActionDialog
      confirmLabel={`Create revision ${scorer.currentRevision + 1}`}
      confirmation={typedConfirmation(environment.type, { phrase: scorer.name })}
      description={
        <>
          Revises <Code>{scorer.name}</Code> from revision {scorer.currentRevision}. Past results
          keep the revision they were scored with.
        </>
      }
      invalid={!configuration.ok}
      onClose={onClose}
      onSuccess={() => void invalidateEvaluations(queryClient, scope)}
      open={open}
      run={(idempotencyKey: string) => {
        if (!configuration.ok) throw new TypeError(configuration.error);
        return reviseScoreDefinition({
          data: {
            body: { ...configuration.value, expectedRevision: scorer.currentRevision },
            idempotencyKey,
            scope,
            scoreDefinitionId: scorer.id,
          },
        });
      }}
      size="2xl"
      successMessage="Scorer revised"
      title={`Revise ${scorer.name}`}
    >
      <ScorerConfigurationFields
        form={form}
        onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
      />
      {configuration.ok ? null : <Text>{configuration.error}</Text>}
    </ActionDialog>
  );
}
