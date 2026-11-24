import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { organizationShellQuery } from "../../data/console-queries.ts";
import {
  releaseCatalogQuery,
  skillContentQuery,
  skillInstallationsQuery,
} from "../../data/managed-skill-queries.ts";
import { UnauthenticatedError } from "../../errors.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import type { AgentTargets, SkillSummary } from "../../skills/skill-state.ts";
import { CodeBlock } from "@/components/reui/code-block/code-block";
import { Button } from "@/components/ui/button";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading, Subheading } from "@/components/ui/heading";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code, Text, TextLink } from "@/components/ui/text";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { describeProblem, ProblemReference } from "../section-boundary.tsx";
import { InstallationGaps, WithAgentTargets } from "./installed-skills.tsx";
import { InstallSkillDialog, targetLabel } from "./skill-dialogs.tsx";
import { StatusBadge } from "@/components/status-badge";

function ContentProblem({ error }: Readonly<{ error: Error }>) {
  if (error instanceof UnauthenticatedError) throw error;
  const problem = describeProblem(error, "The skill could not be read");
  return (
    <Callout variant="destructive">
      <CalloutTitle>{problem.title}</CalloutTitle>
      <CalloutDescription>
        {problem.description ? <p>{problem.description}</p> : null}
        <ProblemReference requestId={problem.requestId} status={problem.status} />
      </CalloutDescription>
    </Callout>
  );
}

function SkillContentSheet({
  onClose,
  skill,
}: Readonly<{ onClose: () => void; skill: SkillSummary }>) {
  const content = useQuery(skillContentQuery(skill.id));
  return (
    <Sheet
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
    >
      <SheetContent className="sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>
            <Code>{skill.key}</Code>
          </SheetTitle>
          {skill.description ? <SheetDescription>{skill.description}</SheetDescription> : null}
        </SheetHeader>
        <SheetBody>
          {content.data ? (
            <>
              <CodeBlock
                code={content.data.content}
                defaultWrap
                label={`${skill.key} content`}
                language="markdown"
              />
              {content.data.referencePaths.length > 0 ? (
                <div className="flex flex-col gap-2">
                  <Subheading level={3}>Reference files</Subheading>
                  <ul className="flex flex-col gap-1">
                    {content.data.referencePaths.map((path) => (
                      <li key={path}>
                        <Code>{path}</Code>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : content.error ? (
            <ContentProblem error={content.error} />
          ) : (
            <Text>Loading the skill…</Text>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

export function ReleaseSkills({
  releaseId,
  scope,
}: Readonly<{ releaseId: string; scope: EnvironmentScope }>) {
  const { access } = useSuspenseQuery(organizationShellQuery(scope.organizationId)).data;
  return (
    <WithAgentTargets permitted={access.listAgentDefinitions} scope={scope}>
      {(targets) => (
        <ReleaseSkillsTable
          canInstall={access.installManagedSkill}
          releaseId={releaseId}
          scope={scope}
          targets={targets}
        />
      )}
    </WithAgentTargets>
  );
}

function ReleaseSkillsTable({
  canInstall,
  releaseId,
  scope,
  targets,
}: Readonly<{
  canInstall: boolean;
  releaseId: string;
  scope: EnvironmentScope;
  targets: AgentTargets | undefined;
}>) {
  const { data: catalog } = useSuspenseQuery(releaseCatalogQuery(releaseId));
  const { data: installations } = useSuspenseQuery(skillInstallationsQuery(scope));
  const [viewing, setViewing] = useState<SkillSummary>();
  const [installing, setInstalling] = useState<SkillSummary>();
  const { release, skills, source } = catalog;
  const keys = new Map(skills.map((skill) => [skill.id, skill.key]));
  const installable = canInstall && release.status === "active" && source.status === "active";
  const agents = targets?.agents ?? [];

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading level={2}>
          {source.name} {release.releaseVersion}
        </Heading>
        <StatusBadge status={release.status} />
      </div>
      <DescriptionList>
        <DescriptionTerm>ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={release.id} />
        </DescriptionDetails>
        <DescriptionTerm>Source</DescriptionTerm>
        <DescriptionDetails>
          <TextLink href={`${environmentPath(scope)}/skills/catalog/${source.id}`}>
            {source.name}
          </TextLink>{" "}
          <StatusBadge status={source.status} />
        </DescriptionDetails>
        <DescriptionTerm>Activated</DescriptionTerm>
        <DescriptionDetails>
          {release.activatedAt ? <Timestamp value={release.activatedAt} /> : "—"}
        </DescriptionDetails>
      </DescriptionList>
      {release.status === "active" && source.status === "active" ? null : (
        <Text>
          The {release.status === "archived" ? "release" : "source"} is archived. Its skills cannot
          be installed, and agents cannot read the ones already installed.
        </Text>
      )}
      <div className="flex flex-col gap-4">
        <Subheading>Skills</Subheading>
        <InstallationGaps gaps={installations.gaps} targets={targets} />
        {catalog.complete ? null : (
          <Text>
            The platform has more managed skills than the console reads at once, so some skills of
            this release may not be listed.
          </Text>
        )}
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Skill</TableHead>
              <TableHead>Depends on</TableHead>
              <TableHead className="text-right">Reference files</TableHead>
              <TableHead>Installed for</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {skills.map((skill) => {
              const installedFor = installations.installed
                .filter((entry) => entry.skill.id === skill.id)
                .map((entry) => targetLabel(entry.installation.target, agents));
              return (
                <TableRow key={skill.id}>
                  <TableCell>
                    <div className="flex flex-col items-start">
                      <Code>{skill.key}</Code>
                      {skill.description ? (
                        <span className="text-sm text-muted-foreground">{skill.description}</span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    {skill.dependencies.length === 0
                      ? "None"
                      : skill.dependencies.map((id) => keys.get(id) ?? id).join(", ")}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{skill.referenceCount}</TableCell>
                  <TableCell>{installedFor.length === 0 ? "—" : installedFor.join(", ")}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <div className="flex justify-end gap-2">
                      <Button onClick={() => setViewing(skill)} variant="ghost">
                        View
                      </Button>
                      {installable ? (
                        <Button onClick={() => setInstalling(skill)} variant="outline">
                          Install
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {viewing ? <SkillContentSheet onClose={() => setViewing(undefined)} skill={viewing} /> : null}
      {installing ? (
        <InstallSkillDialog
          targets={targets}
          installations={installations}
          onClose={() => setInstalling(undefined)}
          open
          release={release}
          releaseSkills={skills}
          scope={scope}
          skill={installing}
        />
      ) : null}
    </div>
  );
}
