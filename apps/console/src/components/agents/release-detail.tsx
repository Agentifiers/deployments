import { useSuspenseQuery } from "@tanstack/react-query";
import { agentReleaseQuery } from "../../data/release-queries.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Subheading } from "@/components/ui/heading";
import { Code } from "@/components/ui/text";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { ManifestView } from "./manifest-view.tsx";
import { StatusBadge } from "@/components/status-badge";

/** One release loaded on demand: its metadata and published manifest. */
export function ReleaseDetail({
  definitionId,
  onClose,
  releaseId,
  scope,
}: Readonly<{
  definitionId: string;
  onClose: () => void;
  releaseId: string;
  scope: EnvironmentScope;
}>) {
  const { data: release } = useSuspenseQuery(agentReleaseQuery(scope, definitionId, releaseId));
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Subheading>Release #{release.releaseNumber}</Subheading>
        <StatusBadge status={release.status} />
        <Button className="ml-auto" onClick={onClose} variant="ghost">
          Close
        </Button>
      </div>
      <DescriptionList>
        <DescriptionTerm>Release ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={release.id} />
        </DescriptionDetails>
        <DescriptionTerm>Content hash</DescriptionTerm>
        <DescriptionDetails>
          <Code className="break-all">{release.contentHash}</Code>
        </DescriptionDetails>
        <DescriptionTerm>Created by</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={release.createdByPrincipalId} />
        </DescriptionDetails>
        <DescriptionTerm>Created</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={release.createdAt} />
        </DescriptionDetails>
        <DescriptionTerm>Resource version</DescriptionTerm>
        <DescriptionDetails>{release.version}</DescriptionDetails>
      </DescriptionList>
      <ManifestView
        label={`Release #${release.releaseNumber} manifest`}
        manifest={release.manifest}
      />
    </section>
  );
}
