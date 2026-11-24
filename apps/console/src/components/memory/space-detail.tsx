import { Archive02Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { spaceQuery } from "../../data/memory-queries.ts";
import { formatExact } from "../../observability/format.ts";
import type { GrantFilter, MemoryStatus } from "../../memory/model.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading } from "@/components/ui/heading";
import { Icon } from "../icon.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { GrantSection } from "./grant-section.tsx";
import { MemorySection } from "./memory-section.tsx";
import { ArchiveSpaceDialog, SPACE_KIND_LABELS } from "./space-dialogs.tsx";
import { StatusBadge } from "@/components/status-badge";

export function SpaceDetail({
  grantFilter,
  memoryStatus,
  onGrantFilter,
  onMemoryStatus,
  scope,
  spaceId,
}: Readonly<{
  grantFilter: GrantFilter;
  memoryStatus: MemoryStatus;
  onGrantFilter: (filter: GrantFilter) => void;
  onMemoryStatus: (status: MemoryStatus) => void;
  scope: EnvironmentScope;
  spaceId: string;
}>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: space } = useSuspenseQuery(spaceQuery(scope, spaceId));
  const [archiving, setArchiving] = useState(false);
  const { access } = shell;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading level={2}>{space.name}</Heading>
        <StatusBadge status={space.status} />
        {access.archiveMemorySpace && space.status === "active" ? (
          <Button className="ml-auto" variant="destructive" onClick={() => setArchiving(true)}>
            <Icon icon={Archive02Icon} />
            Archive
          </Button>
        ) : null}
      </div>
      <DescriptionList>
        <DescriptionTerm>ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={space.id} />
        </DescriptionDetails>
        <DescriptionTerm>Kind</DescriptionTerm>
        <DescriptionDetails>{SPACE_KIND_LABELS[space.kind]}</DescriptionDetails>
        {space.description ? (
          <>
            <DescriptionTerm>Description</DescriptionTerm>
            <DescriptionDetails>{space.description}</DescriptionDetails>
          </>
        ) : null}
        <DescriptionTerm>Retention</DescriptionTerm>
        <DescriptionDetails>
          {space.retentionDays === undefined
            ? "Not set"
            : `${formatExact(space.retentionDays)} days`}
        </DescriptionDetails>
        {space.workspaceId ? (
          <>
            <DescriptionTerm>Workspace</DescriptionTerm>
            <DescriptionDetails>
              <PublicId value={space.workspaceId} />
            </DescriptionDetails>
          </>
        ) : null}
        <DescriptionTerm>Created</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={space.createdAt} />
        </DescriptionDetails>
        <DescriptionTerm>Updated</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={space.updatedAt} />
        </DescriptionDetails>
      </DescriptionList>
      {access.listMemories ? (
        <SectionBoundary resetKey={space.id}>
          <MemorySection
            onStatus={onMemoryStatus}
            scope={scope}
            space={space}
            status={memoryStatus}
          />
        </SectionBoundary>
      ) : null}
      {access.listMemorySpaceGrants ? (
        <SectionBoundary resetKey={space.id}>
          <GrantSection filter={grantFilter} onFilter={onGrantFilter} scope={scope} space={space} />
        </SectionBoundary>
      ) : null}
      {access.archiveMemorySpace ? (
        <ArchiveSpaceDialog
          onClose={() => setArchiving(false)}
          open={archiving}
          scope={scope}
          space={space}
        />
      ) : null}
    </div>
  );
}
