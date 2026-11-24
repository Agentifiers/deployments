import type { ModelAdmissionFailureReason } from "@deployments-ai/model-gateway/model-policy";
import {
  MAX_SCAN_RELEASES,
  type ImpactedRelease,
  type ModelVerdict,
} from "../../models/model-impact.ts";
import { formatExact } from "../../observability/format.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import type { ModelPolicyPreview } from "../../server/model-data.ts";
import { Badge } from "@/components/ui/badge";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Code, Text, TextLink } from "@/components/ui/text";
import { PublicId } from "../public-id.tsx";

const REASON_COPY: Readonly<Record<ModelAdmissionFailureReason, string>> = {
  invalid_model_id: "invalid model ID",
  model_not_allowed_by_environment_policy: "not allowed by the policy",
  model_not_in_catalog: "not in the model catalog",
  unknown_model_provider: "unknown provider",
};

function plural(count: number, one: string, many: string) {
  return `${formatExact(count)} ${count === 1 ? one : many}`;
}

function VerdictBadge({ verdict }: Readonly<{ verdict: ModelVerdict }>) {
  switch (verdict.kind) {
    case "newly_denied":
      return <Badge color="red">{REASON_COPY[verdict.reason]}</Badge>;
    case "already_denied":
      return <Badge color="amber">already {REASON_COPY[verdict.reason]}</Badge>;
    case "newly_allowed":
      return <Badge color="green">now allowed</Badge>;
    case "unchanged_allowed":
      return (
        <Badge color="zinc">
          {verdict.basis === "operator-grant" ? "kept by an operator grant" : "still allowed"}
        </Badge>
      );
    default: {
      const _exhaustive: never = verdict;
      return _exhaustive;
    }
  }
}

function ReleaseList({
  agentNames,
  releases,
  scope,
}: Readonly<{
  agentNames: Readonly<Record<string, string>>;
  releases: readonly ImpactedRelease[];
  scope: EnvironmentScope;
}>) {
  const base = `${environmentPath(scope)}/agents`;
  return (
    <ul className="flex flex-col gap-3">
      {releases.map((release) => (
        <li className="flex flex-col gap-1" key={release.releaseId}>
          <span className="font-medium">
            <TextLink href={`${base}/${release.agentDefinitionId}`}>
              {agentNames[release.agentDefinitionId] ?? release.agentDefinitionId}
            </TextLink>{" "}
            release {formatExact(release.releaseNumber)}
          </span>
          <span className="flex flex-wrap items-center gap-2">
            <TextLink href={`${base}/${release.agentDefinitionId}/deployments`}>
              {release.deployments.length === 1 ? "Deployment" : "Deployments"}
            </TextLink>
            {release.deployments.map((deployment) => (
              <span
                className="inline-flex items-center gap-1"
                key={`${deployment.id}:${deployment.role}`}
              >
                <PublicId value={deployment.id} />
                {deployment.role === "candidate" ? "(canary)" : null}
              </span>
            ))}
          </span>
          <ul className="flex flex-col gap-1">
            {release.models.map((model) => (
              <li
                className="flex flex-wrap items-center gap-2"
                key={`${model.slot}:${model.modelId}`}
              >
                <Code>{model.modelId}</Code>
                {model.slot === "fallback" ? <span>fallback</span> : null}
                <VerdictBadge verdict={model.verdict} />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export function ModelImpactPanel({
  preview,
  scope,
}: Readonly<{ preview: ModelPolicyPreview; scope: EnvironmentScope }>) {
  const { agentNames, impact, issues, unchecked } = preview;
  const { scan } = impact;
  return (
    <div className="flex flex-col gap-4">
      {issues.length > 0 ? (
        <Callout variant="destructive">
          <CalloutTitle>The policy has entries the platform rejects</CalloutTitle>
          <CalloutDescription>
            <ul className="flex flex-col gap-1">
              {issues.map((issue) => (
                <li key={`${issue.entry}:${issue.message}`}>
                  {issue.entry ? <Code>{issue.entry}</Code> : null} {issue.message}
                </li>
              ))}
            </ul>
          </CalloutDescription>
        </Callout>
      ) : null}
      {unchecked.length > 0 ? (
        <Callout>
          <CalloutTitle>
            {plural(unchecked.length, "entry was", "entries were")} not checked against the catalog
          </CalloutTitle>
          <CalloutDescription>
            The model catalog is longer than the check reads, so the platform checks these entries
            when you save:{" "}
            {unchecked.map((modelId, index) => (
              <span key={modelId}>
                {index > 0 ? ", " : null}
                <Code>{modelId}</Code>
              </span>
            ))}
            .
          </CalloutDescription>
        </Callout>
      ) : null}
      <Text>
        Checked {plural(scan.deployments, "live deployment", "live deployments")} running{" "}
        {plural(scan.releases, "release", "releases")}. Every run admits its primary model and each
        fallback again at start, so one model the policy stops admitting fails the run.
      </Text>
      {scan.complete ? null : (
        <Callout variant="destructive">
          <CalloutTitle>The check is incomplete</CalloutTitle>
          <CalloutDescription>
            {scan.unread > 0
              ? `${plural(scan.unread, "release", "releases")} could not be read. `
              : null}
            {scan.skipped > 0
              ? `${plural(scan.skipped, "release was", "releases were")} past the check's limit of ${formatExact(MAX_SCAN_RELEASES)} releases. `
              : null}
            {scan.listsComplete
              ? null
              : "The deployment or model list was longer than the check reads. "}
            Deployments it did not check may lose their models.
          </CalloutDescription>
        </Callout>
      )}
      {impact.newlyDenied.length > 0 ? (
        <Callout variant="destructive">
          <CalloutTitle>
            This change stops admitting models that{" "}
            {plural(impact.newlyDenied.length, "release uses", "releases use")}
          </CalloutTitle>
          <CalloutDescription>
            <ReleaseList agentNames={agentNames} releases={impact.newlyDenied} scope={scope} />
          </CalloutDescription>
        </Callout>
      ) : (
        <Text>No live deployment loses a model.</Text>
      )}
      {impact.alreadyDenied.length > 0 ? (
        <div className="flex flex-col gap-2">
          <Text>
            {plural(impact.alreadyDenied.length, "release already fails", "releases already fail")}{" "}
            admission and this change does not fix it:
          </Text>
          <ReleaseList agentNames={agentNames} releases={impact.alreadyDenied} scope={scope} />
        </div>
      ) : null}
      <Text>
        Operator grants for one agent or workspace are not visible here and can still admit a model.
      </Text>
    </div>
  );
}
