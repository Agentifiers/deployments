import { DatabaseAddIcon } from "@hugeicons/core-free-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { datasetDirectoryQuery, invalidateEvaluations } from "../../data/evaluation-queries.ts";
import { addTraceToDatasetFn } from "../../data/score-result-queries.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import { Description, Field, Label } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { ActionDialog } from "../action-dialog.tsx";
import { Icon } from "../icon.tsx";

/** Captures the trace's root-run input as a regression case, so an evaluation can replay it. */
export function AddTraceToDataset({
  scope,
  traceId,
}: Readonly<{ scope: EnvironmentScope; traceId: string }>) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [datasetId, setDatasetId] = useState("");
  const datasets = useQuery({ ...datasetDirectoryQuery(scope), enabled: open });
  const active = (datasets.data ?? []).filter((dataset) => dataset.status === "active");
  return (
    <>
      <Button onClick={() => setOpen(true)} variant="outline">
        <Icon icon={DatabaseAddIcon} />
        Add to dataset
      </Button>
      <ActionDialog
        confirmLabel="Add case"
        description="The case holds the input of this trace's root run. Evaluation runs on the dataset replay it against a release."
        invalid={datasetId === ""}
        onClose={() => setOpen(false)}
        onSuccess={() => void invalidateEvaluations(queryClient, scope)}
        open={open}
        run={(idempotencyKey) =>
          addTraceToDatasetFn({ data: { datasetId, idempotencyKey, scope, traceId } })
        }
        successMessage={(result) =>
          result.created ? "Case added" : { neutral: "The dataset already has this trace" }
        }
        title="Add this trace to a dataset"
      >
        <Field>
          <Label>Dataset</Label>
          <NativeSelect
            disabled={datasets.isPending}
            name="datasetId"
            onChange={(event) => setDatasetId(event.target.value)}
            value={datasetId}
          >
            <option value="">
              {datasets.isPending ? "Loading datasets…" : "Choose a dataset"}
            </option>
            {active.map((dataset) => (
              <option key={dataset.id} value={dataset.id}>
                {dataset.name}
              </option>
            ))}
          </NativeSelect>
          {datasets.isSuccess && active.length === 0 ? (
            <Description>Create a dataset on the Evaluations page first.</Description>
          ) : null}
        </Field>
      </ActionDialog>
    </>
  );
}
