import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { environmentQuery } from "../../data/console-queries.ts";
import { createEvaluationRun } from "../../data/evaluation-mutations.ts";
import { invalidateEvaluations } from "../../data/evaluation-queries.ts";
import { evaluationRunRequest, type EvaluationRunForm } from "../../evaluations/requests.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Description, Field, Label } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import {
  DatasetSelect,
  NumberField,
  ReleasePicker,
  RuntimeConfigSelect,
  ScorerChecklist,
} from "./pickers.tsx";

function initialForm(agentReleaseId = ""): EvaluationRunForm {
  return {
    agentReleaseId,
    caseTimeoutSeconds: "",
    concurrency: "",
    datasetId: "",
    kind: "dataset-replay",
    runtimeConfigFromAgentDeploymentId: "",
    scoreDefinitionIds: [],
    traceIds: "",
  };
}

/**
 * Starts an evaluation run: a dataset replay against one release, or scoring of existing
 * traces. Callers render it only when `shell.access.createEvaluationRun` is true.
 */
export function StartEvaluationRunDialog({
  agentReleaseId,
  onClose,
  open,
  scope,
}: Readonly<{
  agentReleaseId?: string | undefined;
  onClose: () => void;
  open: boolean;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [form, setForm] = useState(() => initialForm(agentReleaseId));
  useEffect(() => {
    if (open) setForm(initialForm(agentReleaseId));
  }, [agentReleaseId, open]);
  const request = evaluationRunRequest(form);
  const update = (patch: Partial<EvaluationRunForm>) =>
    setForm((current) => ({ ...current, ...patch }));
  const replay = form.kind === "dataset-replay";

  return (
    <ActionDialog
      confirmLabel="Start run"
      confirmation={typedConfirmation(environment.type, { phrase: "evaluate" })}
      description={
        replay
          ? "Replays every dataset case against the release and scores each response. Replays incur model usage."
          : "Scores existing traces with the chosen scorers."
      }
      invalid={!request.ok}
      onClose={onClose}
      onSuccess={(run) => {
        void invalidateEvaluations(queryClient, scope);
        void navigate({
          params: {
            envId: scope.environmentId,
            evaluationRunId: run.id,
            orgId: scope.organizationId,
            projectId: scope.projectId,
          },
          to: "/o/$orgId/p/$projectId/e/$envId/evaluations/runs/$evaluationRunId",
        });
      }}
      open={open}
      run={(idempotencyKey: string) => {
        if (!request.ok) throw new TypeError(request.error);
        return createEvaluationRun({ data: { body: request.value, idempotencyKey, scope } });
      }}
      size="2xl"
      successMessage="Evaluation run started"
      title="Start evaluation run"
    >
      <Field>
        <Label>Kind</Label>
        <NativeSelect
          onChange={(event) =>
            update({
              kind: event.target.value === "trace-score" ? "trace-score" : "dataset-replay",
            })
          }
          value={form.kind}
        >
          <option value="dataset-replay">Dataset replay</option>
          <option value="trace-score">Score traces</option>
        </NativeSelect>
      </Field>
      <SectionBoundary resetKey="evaluation-run-form">
        {replay ? (
          <>
            <ReleasePicker
              label="Release"
              onChange={(releaseId) => update({ agentReleaseId: releaseId })}
              scope={scope}
              value={form.agentReleaseId}
            />
            <DatasetSelect
              onChange={(datasetId) => update({ datasetId })}
              scope={scope}
              value={form.datasetId}
            />
          </>
        ) : (
          <Field>
            <Label>Trace IDs</Label>
            <Description>Up to 100 trace IDs, separated by commas, spaces, or lines.</Description>
            <Textarea
              className="font-mono"
              onChange={(event) => update({ traceIds: event.target.value })}
              rows={4}
              value={form.traceIds}
            />
          </Field>
        )}
        <ScorerChecklist
          onChange={(scoreDefinitionIds) => update({ scoreDefinitionIds })}
          scope={scope}
          value={form.scoreDefinitionIds}
        />
        {replay ? (
          <>
            <RuntimeConfigSelect
              onChange={(runtimeConfigFromAgentDeploymentId) =>
                update({ runtimeConfigFromAgentDeploymentId })
              }
              releaseIds={[form.agentReleaseId]}
              scope={scope}
              value={form.runtimeConfigFromAgentDeploymentId}
            />
            <div className="grid gap-6 sm:grid-cols-2">
              <NumberField
                description="Cases replayed in parallel (1–20)."
                label="Concurrency"
                onChange={(concurrency) => update({ concurrency })}
                placeholder="Default"
                value={form.concurrency}
              />
              <NumberField
                description="Per-case limit in seconds (30–3600)."
                label="Case timeout"
                onChange={(caseTimeoutSeconds) => update({ caseTimeoutSeconds })}
                placeholder="Default"
                value={form.caseTimeoutSeconds}
              />
            </div>
          </>
        ) : null}
        {request.ok ? null : <Text>{request.error}</Text>}
      </SectionBoundary>
    </ActionDialog>
  );
}
