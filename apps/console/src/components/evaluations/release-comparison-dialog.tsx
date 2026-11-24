import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { environmentQuery } from "../../data/console-queries.ts";
import { createReleaseComparison } from "../../data/evaluation-mutations.ts";
import { invalidateEvaluations } from "../../data/evaluation-queries.ts";
import {
  comparisonRequest,
  GATE_POLICY_FIELDS,
  type ComparisonForm,
  type GatePolicyField,
} from "../../evaluations/requests.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Fieldset, Legend } from "@/components/ui/field";
import { Text } from "@/components/ui/text";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import {
  DatasetSelect,
  NumberField,
  ReleasePicker,
  RuntimeConfigSelect,
  ScorerChecklist,
} from "./pickers.tsx";

const EMPTY_GATE_POLICY: Readonly<Record<GatePolicyField, string>> = {
  maxEvaluatorErrorRate: "",
  maxMeanDecrease: "",
  maxMissingEvidenceRate: "",
  maxNewFailures: "",
  maxPassRateDecrease: "",
  minComparableCases: "",
};

function initialForm(baselineReleaseId = "", candidateReleaseId = ""): ComparisonForm {
  return {
    baselineReleaseId,
    candidateReleaseId,
    caseTimeoutSeconds: "",
    concurrency: "",
    datasetId: "",
    gatePolicy: EMPTY_GATE_POLICY,
    runtimeConfigFromAgentDeploymentId: "",
    scoreDefinitionIds: [],
  };
}

/**
 * Starts an advisory release comparison: both releases replay one dataset and the chosen
 * scorers, then the API reports deltas and a pass/fail verdict against the gate policy.
 * Callers render it only when `shell.access.createReleaseComparison` is true.
 */
export function StartReleaseComparisonDialog({
  baselineReleaseId,
  candidateReleaseId,
  onClose,
  open,
  scope,
}: Readonly<{
  baselineReleaseId?: string | undefined;
  candidateReleaseId?: string | undefined;
  onClose(): void;
  open: boolean;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [form, setForm] = useState(() => initialForm(baselineReleaseId, candidateReleaseId));
  useEffect(() => {
    if (open) setForm(initialForm(baselineReleaseId, candidateReleaseId));
  }, [baselineReleaseId, candidateReleaseId, open]);
  const request = comparisonRequest(form);
  const update = (patch: Partial<ComparisonForm>) =>
    setForm((current) => ({ ...current, ...patch }));

  return (
    <ActionDialog
      confirmLabel="Start comparison"
      confirmation={typedConfirmation(environment.type, { phrase: "compare" })}
      description="Both releases replay the dataset with the chosen scorers. The verdict is advisory: it never blocks a promotion. Replays incur model usage."
      invalid={!request.ok}
      onClose={onClose}
      onSuccess={(comparison) => {
        void invalidateEvaluations(queryClient, scope);
        void navigate({
          params: {
            envId: scope.environmentId,
            orgId: scope.organizationId,
            projectId: scope.projectId,
            releaseComparisonId: comparison.id,
          },
          to: "/o/$orgId/p/$projectId/e/$envId/evaluations/comparisons/$releaseComparisonId",
        });
      }}
      open={open}
      run={(idempotencyKey: string) => {
        if (!request.ok) throw new TypeError(request.error);
        return createReleaseComparison({ data: { body: request.value, idempotencyKey, scope } });
      }}
      size="2xl"
      successMessage="Release comparison started"
      title="Compare releases"
    >
      <SectionBoundary resetKey="release-comparison-form">
        <ReleasePicker
          description="The release currently trusted."
          label="Baseline"
          onChange={(releaseId) => update({ baselineReleaseId: releaseId })}
          scope={scope}
          value={form.baselineReleaseId}
        />
        <ReleasePicker
          description="The release under test."
          label="Candidate"
          onChange={(releaseId) => update({ candidateReleaseId: releaseId })}
          scope={scope}
          value={form.candidateReleaseId}
        />
        <DatasetSelect
          onChange={(datasetId) => update({ datasetId })}
          scope={scope}
          value={form.datasetId}
        />
        <ScorerChecklist
          onChange={(scoreDefinitionIds) => update({ scoreDefinitionIds })}
          scope={scope}
          value={form.scoreDefinitionIds}
        />
        <RuntimeConfigSelect
          onChange={(runtimeConfigFromAgentDeploymentId) =>
            update({ runtimeConfigFromAgentDeploymentId })
          }
          releaseIds={[form.baselineReleaseId, form.candidateReleaseId]}
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
        <Fieldset>
          <Legend>Gate policy</Legend>
          <Text>Optional thresholds for the advisory verdict; blank keeps the default.</Text>
          <div className="mt-4 grid gap-6 sm:grid-cols-3">
            {Object.entries(GATE_POLICY_FIELDS).map(([key, label]) => {
              const field = key as GatePolicyField;
              return (
                <NumberField
                  key={field}
                  label={label}
                  onChange={(text) => update({ gatePolicy: { ...form.gatePolicy, [field]: text } })}
                  placeholder="Default"
                  value={form.gatePolicy[field]}
                />
              );
            })}
          </div>
        </Fieldset>
        {request.ok ? null : <Text>{request.error}</Text>}
      </SectionBoundary>
    </ActionDialog>
  );
}
