import { Archive02Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { OperationAccess } from "../../access.ts";
import { appWrites, liveReleaseId } from "../../apps/app-state.ts";
import { appQuery } from "../../data/app-queries.ts";
import { agentDirectoryQuery } from "../../data/observability-queries.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading } from "@/components/ui/heading";
import { Skeleton } from "@/components/ui/skeleton";
import { TextLink } from "@/components/ui/text";
import { Icon } from "../icon.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { AppDialogs, type AppDialog } from "./app-dialogs.tsx";
import { AppDomains } from "./app-domains.tsx";
import { AppGrants, AppPublication, AppReleases } from "./app-sections.tsx";
import { StatusBadge } from "@/components/status-badge";

function AgentDefinition({
  access,
  definitionId,
  scope,
}: Readonly<{ access: OperationAccess; definitionId: string; scope: EnvironmentScope }>) {
  const directory = useQuery({
    ...agentDirectoryQuery(scope),
    enabled: access.listAgentDefinitions && access.listAgentDeployments,
  });
  const name = directory.data?.definitions.find((entry) => entry.id === definitionId)?.name;
  return name === undefined ? (
    <PublicId value={definitionId} />
  ) : (
    <TextLink href={`${environmentPath(scope)}/agents/${definitionId}`}>{name}</TextLink>
  );
}

export function AppDetail({
  access,
  appId,
  scope,
}: Readonly<{ access: OperationAccess; appId: string; scope: EnvironmentScope }>) {
  const { data: app } = useSuspenseQuery(appQuery(scope, appId));
  const [dialog, setDialog] = useState<AppDialog>();
  const { lifecycle } = app;
  const writes = appWrites(lifecycle.state, access);
  const live = liveReleaseId(lifecycle);
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-wrap items-center gap-3">
        <Heading level={2}>{app.name}</Heading>
        <StatusBadge status={lifecycle.state} />
        <div className="ml-auto flex flex-wrap gap-3">
          {writes.archiveApp?.enabled ? (
            <Button onClick={() => setDialog({ kind: "archive" })} variant="outline">
              <Icon icon={Archive02Icon} />
              Archive
            </Button>
          ) : null}
          {writes.eraseApp?.enabled ? (
            <Button onClick={() => setDialog({ kind: "erase" })} variant="destructive">
              <Icon icon={Delete02Icon} />
              Delete
            </Button>
          ) : null}
        </div>
      </div>
      {lifecycle.state === "failed" ? (
        <Callout variant="destructive">
          <CalloutTitle>Provisioning failed</CalloutTitle>
          <CalloutDescription>{lifecycle.reason}</CalloutDescription>
        </Callout>
      ) : null}
      <DescriptionList>
        <DescriptionTerm>URL</DescriptionTerm>
        <DescriptionDetails>
          <TextLink href={app.url} rel="noreferrer" target="_blank">
            {app.url}
          </TextLink>
        </DescriptionDetails>
        <DescriptionTerm>Live release</DescriptionTerm>
        <DescriptionDetails>
          {live === null ? "None, the app is a draft" : <PublicId value={live} />}
        </DescriptionDetails>
        <DescriptionTerm>Agent definition</DescriptionTerm>
        <DescriptionDetails>
          <AgentDefinition access={access} definitionId={app.agentDefinitionId} scope={scope} />
        </DescriptionDetails>
        <DescriptionTerm>Member access</DescriptionTerm>
        <DescriptionDetails>
          <span className="flex flex-wrap items-center gap-3">
            {app.access.organizationMembers}
            {writes.updateApp?.enabled ? (
              <Button onClick={() => setDialog({ kind: "access" })} variant="ghost">
                Change
              </Button>
            ) : null}
          </span>
        </DescriptionDetails>
        <DescriptionTerm>Created</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={app.createdAt} />
        </DescriptionDetails>
        <DescriptionTerm>Created by run</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={app.createdBy.runId} />
        </DescriptionDetails>
        <DescriptionTerm>Workspace</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={app.workspaceId} />
        </DescriptionDetails>
        <DescriptionTerm>ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={app.id} />
        </DescriptionDetails>
      </DescriptionList>
      <AppPublication app={app} onDialog={setDialog} writes={writes} />
      {access.listAppDomains ? (
        <SectionBoundary fallback={<Skeleton className="h-32 rounded-lg" />} resetKey={appId}>
          <AppDomains app={app} scope={scope} writes={writes} />
        </SectionBoundary>
      ) : null}
      {access.listAppGrants ? (
        <SectionBoundary fallback={<Skeleton className="h-32 rounded-lg" />} resetKey={appId}>
          <AppGrants appId={appId} onDialog={setDialog} scope={scope} writes={writes} />
        </SectionBoundary>
      ) : null}
      {access.listAppReleases ? (
        <SectionBoundary fallback={<Skeleton className="h-32 rounded-lg" />} resetKey={appId}>
          <AppReleases appId={appId} onDialog={setDialog} scope={scope} writes={writes} />
        </SectionBoundary>
      ) : null}
      <AppDialogs app={app} dialog={dialog} onClose={() => setDialog(undefined)} scope={scope} />
    </div>
  );
}
