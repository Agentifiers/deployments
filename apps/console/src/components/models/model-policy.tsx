import { Archive02Icon, PencilEdit02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import type { ModelPolicyResponse } from "@deployments-ai/api-contract/models";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { activeModelPolicyQuery, modelPolicyPagesQuery } from "../../data/model-queries.ts";
import { formatExact } from "../../observability/format.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
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
import { Icon } from "../icon.tsx";
import { LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { ArchiveModelPolicyDialog } from "./model-policy-dialogs.tsx";
import { StatusBadge } from "@/components/status-badge";

function PolicyEntries({ policy }: Readonly<{ policy: ModelPolicyResponse }>) {
  return policy.models.length === 0 ? (
    "None"
  ) : (
    <ul className="flex flex-col gap-1">
      {policy.models.map((entry) => (
        <li key={entry}>
          <Code>{entry}</Code>
        </li>
      ))}
    </ul>
  );
}

export function ActiveModelPolicy({ scope }: Readonly<{ scope: EnvironmentScope }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: policy } = useSuspenseQuery(activeModelPolicyQuery(scope));
  const [archiving, setArchiving] = useState(false);
  const editPath = `${environmentPath(scope)}/models/policy/edit`;

  if (!policy) {
    return (
      <div className="flex flex-col gap-4">
        <Text>
          This environment runs the curated defaults: agents may use only the platform&apos;s
          curated models. A model policy can keep or drop the curated models and allow more models
          or whole providers from the catalog.
        </Text>
        {shell.access.createModelPolicy ? (
          <div>
            <Button href={editPath}>
              <Icon icon={PlusSignIcon} />
              Create policy
            </Button>
          </div>
        ) : (
          <Text>An owner or admin can create a model policy.</Text>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Heading level={2}>{policy.name}</Heading>
        <StatusBadge status={policy.status} />
        <div className="ml-auto flex flex-wrap gap-3">
          {shell.access.updateModelPolicy ? (
            <Button href={editPath} variant="outline">
              <Icon icon={PencilEdit02Icon} />
              Edit
            </Button>
          ) : null}
          {shell.access.archiveModelPolicy ? (
            <Button onClick={() => setArchiving(true)} variant="outline">
              <Icon icon={Archive02Icon} />
              Archive
            </Button>
          ) : null}
        </div>
      </div>
      <DescriptionList>
        <DescriptionTerm>Description</DescriptionTerm>
        <DescriptionDetails>{policy.description || "None"}</DescriptionDetails>
        <DescriptionTerm>Curated models</DescriptionTerm>
        <DescriptionDetails>
          {policy.includeCuratedModels ? "Allowed" : "Not allowed unless listed below"}
        </DescriptionDetails>
        <DescriptionTerm>Also allowed</DescriptionTerm>
        <DescriptionDetails>
          <PolicyEntries policy={policy} />
        </DescriptionDetails>
        <DescriptionTerm>Version</DescriptionTerm>
        <DescriptionDetails>{formatExact(policy.version)}</DescriptionDetails>
        <DescriptionTerm>Updated</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={policy.updatedAt} />
        </DescriptionDetails>
        <DescriptionTerm>ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={policy.id} />
        </DescriptionDetails>
      </DescriptionList>
      {shell.access.archiveModelPolicy ? (
        <ArchiveModelPolicyDialog
          onClose={() => setArchiving(false)}
          open={archiving}
          policy={policy}
          scope={scope}
        />
      ) : null}
    </div>
  );
}

export function ModelPolicyHistory({ scope }: Readonly<{ scope: EnvironmentScope }>) {
  return (
    <div className="flex flex-col gap-4">
      <Subheading>History</Subheading>
      <SectionBoundary resetKey={scope.environmentId}>
        <PolicyTable scope={scope} />
      </SectionBoundary>
    </div>
  );
}

function PolicyTable({ scope }: Readonly<{ scope: EnvironmentScope }>) {
  const pagesQuery = modelPolicyPagesQuery(scope);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const policies = data.pages.flatMap((page) => page.items);
  return (
    <div className="flex flex-col gap-4">
      {policies.length === 0 ? (
        <Text>No model policy has been created in this environment.</Text>
      ) : (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Curated</TableHead>
              <TableHead className="text-right">Entries</TableHead>
              <TableHead className="text-right">Version</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Archived</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {policies.map((policy) => (
              <TableRow key={policy.id}>
                <TableCell>{policy.name}</TableCell>
                <TableCell>
                  <StatusBadge status={policy.status} />
                </TableCell>
                <TableCell>{policy.includeCuratedModels ? "allowed" : "dropped"}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatExact(policy.models.length)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatExact(policy.version)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={policy.createdAt} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {policy.archivedAt ? <Timestamp value={policy.archivedAt} /> : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <LoadMore
        error={error}
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        queryKey={pagesQuery.queryKey}
      />
    </div>
  );
}
