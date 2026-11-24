import { useQuery } from "@tanstack/react-query";
import type { ToolBinding } from "../../../agents/runtime-config.ts";
import {
  previewGroups,
  type BindingModel,
  type BindingWorkbench,
  type Preflight,
  type ToolEvaluation,
} from "../../../agents/tool-bindings.ts";
import { bindingPreviewQuery } from "../../../data/tool-binding-queries.ts";
import type { EnvironmentScope } from "../../../scope.ts";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Code, Text } from "@/components/ui/text";
import { BindingsTable } from "./bindings-table.tsx";

function preflightText(preflight: Preflight) {
  switch (preflight.kind) {
    case "model_not_allowed":
      return (
        <>
          The environment's model policy does not allow <Code>{preflight.modelId}</Code>.
        </>
      );
    case "sub_agent_unresolvable":
      return (
        <>
          Sub-agent <Code>{preflight.key}</Code> is bound to deployment …
          {preflight.deploymentId.slice(-8)}, which is{" "}
          {preflight.reason === "stopped" ? "stopped" : "gone"}.
        </>
      );
    default: {
      const unexpected: never = preflight;
      return unexpected;
    }
  }
}

export function BindingsEditor({
  definitionId,
  model,
  onChoose,
  readOnly = false,
  scope,
  workbench,
}: Readonly<{
  definitionId: string;
  model: BindingModel;
  onChoose: (tool: string, binding: ToolBinding | null) => void;
  readOnly?: boolean;
  scope: EnvironmentScope;
  workbench: BindingWorkbench;
}>) {
  const preview = useQuery(bindingPreviewQuery(scope, definitionId, previewGroups(model)));
  const evaluations = new Map<string, ToolEvaluation>(
    (preview.data ?? []).flatMap((group) =>
      "results" in group
        ? group.results.map(
            (result) => [`${group.toolPolicyId} ${result.toolName}`, result] as const,
          )
        : [],
    ),
  );
  const failed = (preview.data ?? []).flatMap((group) => ("problem" in group ? [group] : []));
  return (
    <div className="flex flex-col gap-6">
      {workbench.preflight.length > 0 ? (
        <Callout>
          <CalloutTitle>
            The platform may refuse this for reasons outside tool bindings
          </CalloutTitle>
          <CalloutDescription>
            <ul className="list-disc pl-5">
              {workbench.preflight.map((preflight) => (
                <li
                  key={preflight.kind === "model_not_allowed" ? preflight.modelId : preflight.key}
                >
                  {preflightText(preflight)}
                </li>
              ))}
            </ul>
            <p>
              Deploying, or saving bindings on a running deployment, re-admits the release's models
              against the model policy. Every save re-resolves sub-agent bindings.
            </p>
          </CalloutDescription>
        </Callout>
      ) : null}
      {model.dropped.length > 0 ? (
        <Callout>
          <CalloutTitle>Bindings the release cannot accept are removed</CalloutTitle>
          <CalloutDescription>
            {model.dropped.map((tool, index) => (
              <span key={tool}>
                {index > 0 ? ", " : ""}
                <Code>{tool}</Code>
              </span>
            ))}{" "}
            {model.dropped.length === 1 ? "is" : "are"} not declared with workspace authorization by
            every release this deployment runs.
          </CalloutDescription>
        </Callout>
      ) : null}
      {failed.length > 0 ? (
        <Callout variant="destructive">
          <CalloutTitle>Some decisions could not be previewed</CalloutTitle>
          <CalloutDescription>
            {failed.map(({ problem, toolPolicyId }) => (
              <p key={toolPolicyId}>
                Policy …{toolPolicyId.slice(-8)}: {problem.detail ?? problem.title}
              </p>
            ))}
          </CalloutDescription>
        </Callout>
      ) : null}
      {model.rows.length === 0 ? (
        <Text>
          The release declares no tool with workspace authorization, so the deployment needs no tool
          bindings.
        </Text>
      ) : (
        <BindingsTable
          evaluations={evaluations}
          model={model}
          onChoose={onChoose}
          readOnly={readOnly}
          scope={scope}
          workbench={workbench}
        />
      )}
      <Text>
        This page previews which grants fit and what each policy decides before you save. After
        saving, the Tools & access tab shows what the deployment actually allows.
      </Text>
    </div>
  );
}
