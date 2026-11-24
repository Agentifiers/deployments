import { BookOpen01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { agentTargetsQuery, skillInstallationsQuery } from "../../data/managed-skill-queries.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import type {
  AgentTargets,
  DependencyStatus,
  Health,
  InstallationGap,
  InstalledSkill,
} from "../../skills/skill-state.ts";
import type { BadgeColor } from "../../status.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code, Text, TextLink } from "@/components/ui/text";
import { ListEmpty } from "../list-controls.tsx";
import { RemoveSkillDialog, targetLabel } from "./skill-dialogs.tsx";

const HEALTH_BADGES: Readonly<
  Record<Health, { readonly color: BadgeColor; readonly label: string }>
> = {
  release_archived: { color: "amber", label: "release archived" },
  serving: { color: "green", label: "serving" },
  source_archived: { color: "amber", label: "source archived" },
};

const GAP_NOTICES: Readonly<Record<InstallationGap | "agents" | "agentScope", string>> = {
  agentScope:
    "Your role or token scopes do not permit listing agents (agents:read), so agents show by ID and are not offered as install targets.",
  agents:
    "The environment has more agents than the console reads at once, so some agents show by ID and are not offered as install targets.",
  dependencies:
    "The installed skills declare more dependencies than the console reads at once, so some dependencies show by ID.",
  installations:
    "The environment has more installations than the console reads at once, so some are not listed.",
  releases:
    "A source has more releases than the console reads at once, so a newer release may not be offered.",
};

export function InstallationGaps({
  gaps,
  targets,
}: Readonly<{ gaps: readonly InstallationGap[]; targets: AgentTargets | undefined }>) {
  const agentGap =
    targets === undefined
      ? (["agentScope"] as const)
      : targets.complete
        ? []
        : (["agents"] as const);
  return [...gaps, ...agentGap].map((gap) => <Text key={gap}>{GAP_NOTICES[gap]}</Text>);
}

function ReadAgentTargets({
  children,
  scope,
}: Readonly<{ children: (targets: AgentTargets) => ReactNode; scope: EnvironmentScope }>) {
  return children(useSuspenseQuery(agentTargetsQuery(scope)).data);
}

export function WithAgentTargets({
  children,
  permitted,
  scope,
}: Readonly<{
  children: (targets: AgentTargets | undefined) => ReactNode;
  permitted: boolean;
  scope: EnvironmentScope;
}>) {
  return permitted ? (
    <ReadAgentTargets scope={scope}>{children}</ReadAgentTargets>
  ) : (
    children(undefined)
  );
}

function DependencyBadge({ dependency }: Readonly<{ dependency: DependencyStatus }>) {
  const { state } = dependency;
  const detail =
    state.kind === "missing"
      ? "missing"
      : state.via === "environment"
        ? "installed for the environment"
        : "installed";
  return (
    <Badge color={state.kind === "missing" ? "red" : "green"}>
      {dependency.key ?? `…${dependency.skillId.slice(-8)}`}: {detail}
    </Badge>
  );
}

export function InstalledSkills({ scope }: Readonly<{ scope: EnvironmentScope }>) {
  const { access } = useSuspenseQuery(organizationShellQuery(scope.organizationId)).data;
  return (
    <WithAgentTargets permitted={access.listAgentDefinitions} scope={scope}>
      {(targets) => (
        <InstalledTable
          removable={access.removeManagedSkillInstallation}
          scope={scope}
          targets={targets}
        />
      )}
    </WithAgentTargets>
  );
}

function InstalledTable({
  removable,
  scope,
  targets,
}: Readonly<{ removable: boolean; scope: EnvironmentScope; targets: AgentTargets | undefined }>) {
  const { data } = useSuspenseQuery(skillInstallationsQuery(scope));
  const [removing, setRemoving] = useState<InstalledSkill>();
  const basePath = `${environmentPath(scope)}/skills`;
  const agents = targets?.agents ?? [];

  if (data.installed.length === 0 && data.gaps.length === 0) {
    return (
      <ListEmpty
        docs="/docs/capabilities/managed-skills"
        icon={BookOpen01Icon}
        title="No managed skills installed"
      >
        Install a released skill from the <TextLink href={`${basePath}/catalog`}>catalog</TextLink>{" "}
        for the whole environment or for one agent.
      </ListEmpty>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <InstallationGaps gaps={data.gaps} targets={targets} />
      <Table striped>
        <TableHeader>
          <TableRow>
            <TableHead>Skill</TableHead>
            <TableHead>Release</TableHead>
            <TableHead>Installed for</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Dependencies</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.installed.map((entry) => {
            const { installation, release, skill, source, successor } = entry;
            const { target } = installation;
            return (
              <TableRow key={installation.id}>
                <TableCell>
                  <div className="flex flex-col items-start">
                    <Code>{skill.key}</Code>
                    <TextLink className="text-sm" href={`${basePath}/catalog/${source.id}`}>
                      {source.name}
                    </TextLink>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col items-start">
                    <TextLink href={`${basePath}/releases/${release.id}`}>
                      {release.releaseVersion}
                    </TextLink>
                    {successor?.kind === "available" ? (
                      <TextLink
                        className="text-sm"
                        href={`${basePath}/releases/${successor.release.id}`}
                      >
                        {successor.release.releaseVersion} available
                      </TextLink>
                    ) : null}
                    {successor?.kind === "installed" ? (
                      <span className="text-sm text-muted-foreground">
                        {successor.release.releaseVersion} is also installed
                      </span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  {target.kind === "environment" || targets === undefined ? (
                    targetLabel(target, agents)
                  ) : (
                    <TextLink href={`${environmentPath(scope)}/agents/${target.agentDefinitionId}`}>
                      {targetLabel(target, agents)}
                    </TextLink>
                  )}
                </TableCell>
                <TableCell>
                  <Badge color={HEALTH_BADGES[entry.health].color}>
                    {HEALTH_BADGES[entry.health].label}
                  </Badge>
                </TableCell>
                <TableCell>
                  {entry.dependencies.length === 0 ? (
                    "None"
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {entry.dependencies.map((dependency) => (
                        <DependencyBadge dependency={dependency} key={dependency.skillId} />
                      ))}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {removable ? (
                    <Button onClick={() => setRemoving(entry)} variant="outline">
                      {successor?.kind === "installed" ? "Remove the older release" : "Remove"}
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {removing ? (
        <RemoveSkillDialog
          agents={agents}
          entry={removing}
          installations={data}
          onClose={() => setRemoving(undefined)}
          open
          scope={scope}
        />
      ) : null}
    </div>
  );
}
