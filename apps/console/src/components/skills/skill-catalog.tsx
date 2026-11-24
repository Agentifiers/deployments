import { BookOpen01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { skillSourcesQuery, sourceCatalogQuery } from "../../data/managed-skill-queries.ts";
import { oneOf } from "../../observability/range.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { newestReleaseFirst, SOURCE_VIEWS, type SourceView } from "../../skills/skill-state.ts";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading, Subheading } from "@/components/ui/heading";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code, Text } from "@/components/ui/text";
import { SingleToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ListEmpty } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { StatusBadge } from "@/components/status-badge";

function CatalogAuthoringNote({ children }: Readonly<{ children?: ReactNode }>) {
  return (
    <>
      {children}
      {children ? " " : null}The console cannot change the catalog: publishing needs a platform
      administrator holding <Code>managed-skills:admin</Code>, a scope the console never requests.
    </>
  );
}

const VIEW_LABELS: Readonly<Record<SourceView, string>> = {
  active: "Active",
  all: "All sources",
};

export function SkillSources({
  onView,
  scope,
  view,
}: Readonly<{
  onView: (view: SourceView) => void;
  scope: EnvironmentScope;
  view: SourceView;
}>) {
  const { data } = useSuspenseQuery(skillSourcesQuery());
  const { sources } = data;
  const shown = view === "all" ? sources : sources.filter(({ status }) => status === "active");
  const hidden = sources.length - shown.length;
  const basePath = `${environmentPath(scope)}/skills/catalog`;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <SingleToggleGroup
          aria-label="Sources shown"
          onValueChange={(next) => {
            const nextView = oneOf(SOURCE_VIEWS, next);
            if (nextView) onView(nextView);
          }}
          size="sm"
          value={view}
        >
          {SOURCE_VIEWS.map((option) => (
            <ToggleGroupItem key={option} value={option}>
              {VIEW_LABELS[option]}
            </ToggleGroupItem>
          ))}
        </SingleToggleGroup>
        {hidden > 0 ? <Text>{hidden} archived hidden.</Text> : null}
      </div>
      {data.complete ? null : (
        <Text>
          The platform has more skill sources than the console reads at once, so some are not
          listed.
        </Text>
      )}
      {shown.length === 0 ? (
        <ListEmpty
          docs="/docs/capabilities/managed-skills"
          icon={BookOpen01Icon}
          title="No managed skill sources"
        >
          <CatalogAuthoringNote>
            The catalog is shared by every organization on this platform.
          </CatalogAuthoringNote>
        </ListEmpty>
      ) : (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Repository</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((source) => (
              <TableRow href={`${basePath}/${source.id}`} key={source.id} title={source.name}>
                <TableCell>{source.name}</TableCell>
                <TableCell>
                  <Code>{source.key}</Code>
                </TableCell>
                <TableCell>
                  <StatusBadge status={source.status} />
                </TableCell>
                <TableCell className="max-w-64 truncate">{source.repositoryUrl ?? "—"}</TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={source.createdAt} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

export function SkillSource({
  scope,
  sourceId,
}: Readonly<{ scope: EnvironmentScope; sourceId: string }>) {
  const { data } = useSuspenseQuery(sourceCatalogQuery(sourceId));
  const { source } = data;
  const releasesPath = `${environmentPath(scope)}/skills/releases`;
  const releases = newestReleaseFirst(data.releases);
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading level={2}>{source.name}</Heading>
        <StatusBadge status={source.status} />
      </div>
      <DescriptionList>
        <DescriptionTerm>ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={source.id} />
        </DescriptionDetails>
        <DescriptionTerm>Key</DescriptionTerm>
        <DescriptionDetails>
          <Code>{source.key}</Code>
        </DescriptionDetails>
        <DescriptionTerm>Repository</DescriptionTerm>
        <DescriptionDetails>
          {source.repositoryUrl ? <Code>{source.repositoryUrl}</Code> : "—"}
          {source.pinnedCommit ? (
            <>
              {" "}
              at <Code>{source.pinnedCommit.slice(0, 12)}</Code>
            </>
          ) : null}
        </DescriptionDetails>
        <DescriptionTerm>Created</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={source.createdAt} />
        </DescriptionDetails>
      </DescriptionList>
      <div className="flex flex-col gap-4">
        <Subheading>Releases</Subheading>
        {data.complete ? null : (
          <Text>
            This source has more releases than the console reads at once, so some are not listed.
          </Text>
        )}
        {releases.length === 0 ? (
          <Text>
            <CatalogAuthoringNote>This source has no releases.</CatalogAuthoringNote>
          </Text>
        ) : (
          <Table striped>
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Skills</TableHead>
                <TableHead>Activated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {releases.map((release) => (
                <TableRow
                  href={`${releasesPath}/${release.id}`}
                  key={release.id}
                  title={release.releaseVersion}
                >
                  <TableCell>{release.releaseVersion}</TableCell>
                  <TableCell>
                    <StatusBadge status={release.status} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{release.skillCount}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {release.activatedAt ? <Timestamp value={release.activatedAt} /> : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
