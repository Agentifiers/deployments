import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { canonicalManifestJson } from "../../agents/manifest-diff.ts";
import { agentReleaseQuery } from "../../data/release-queries.ts";
import type { EnvironmentScope } from "../../scope.ts";
import type { AgentDetail } from "../../server/agent-data.ts";
import type { EnvironmentSummary } from "../../server/console-data.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { PublishDraftDialog } from "./release-dialogs.tsx";

function PublishState({
  agent,
  canPublish,
  changed,
  environment,
  latestManifest,
  scope,
}: Readonly<{
  agent: AgentDetail;
  canPublish: boolean;
  changed: boolean;
  environment: EnvironmentSummary;
  latestManifest: unknown;
  scope: EnvironmentScope;
}>) {
  const [open, setOpen] = useState(false);
  const { definition } = agent;
  const latest = agent.releases[0];
  const blocked =
    definition.status === "archived"
      ? "Archived definitions cannot publish."
      : changed
        ? undefined
        : `The draft matches release #${latest?.releaseNumber ?? ""}; publishing would add an identical release.`;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Text>
        Draft {definition.version}
        {latest ? null : " · never published"}
      </Text>
      {latest ? (
        <Badge color={changed ? "amber" : "green"}>
          {changed ? `changed since #${latest.releaseNumber}` : `matches #${latest.releaseNumber}`}
        </Badge>
      ) : null}
      {canPublish ? (
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {blocked ? <Text>{blocked}</Text> : null}
          <Button disabled={blocked !== undefined} onClick={() => setOpen(true)}>
            Publish draft
          </Button>
        </div>
      ) : null}
      {canPublish ? (
        <PublishDraftDialog
          agent={agent}
          environment={environment}
          latestManifest={latestManifest}
          latestNumber={latest?.releaseNumber}
          onClose={() => setOpen(false)}
          open={open}
          scope={scope}
        />
      ) : null}
    </div>
  );
}

/** Loads the latest release to tell whether the draft's manifest differs from it. */
function ComparedPublishState(
  props: Readonly<{
    agent: AgentDetail;
    canPublish: boolean;
    environment: EnvironmentSummary;
    latestId: string;
    scope: EnvironmentScope;
  }>,
) {
  const { data: latest } = useSuspenseQuery(
    agentReleaseQuery(props.scope, props.agent.definition.id, props.latestId),
  );
  const changed =
    canonicalManifestJson(props.agent.definition.draft) !== canonicalManifestJson(latest.manifest);
  return <PublishState {...props} changed={changed} latestManifest={latest.manifest} />;
}

/**
 * The draft's publish state: whether it differs from the latest release, and the publish action,
 * which shows the draft's changes since that release before it publishes.
 */
export function ReleaseDraftPanel(
  props: Readonly<{
    agent: AgentDetail;
    canPublish: boolean;
    environment: EnvironmentSummary;
    scope: EnvironmentScope;
  }>,
) {
  const latest = props.agent.releases[0];
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
      {latest ? (
        <ComparedPublishState {...props} latestId={latest.id} />
      ) : (
        <PublishState {...props} changed latestManifest={undefined} />
      )}
    </div>
  );
}
