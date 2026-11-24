import { useSuspenseQuery } from "@tanstack/react-query";
import type { BrainEntityView } from "../../brains/content.ts";
import { brainEntityQuery } from "../../data/brain-queries.ts";
import { Badge } from "@/components/ui/badge";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading, Subheading } from "@/components/ui/heading";
import { Link } from "@/components/ui/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Text } from "@/components/ui/text";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { StatusBadge } from "@/components/status-badge";

type Endpoint = BrainEntityView["edges"][number]["from"];

const ENDPOINT_SEGMENTS: Readonly<Record<Endpoint["kind"], string>> = {
  document: "documents",
  entity: "entities",
};

function EndpointLink({
  brainPath,
  endpoint,
}: Readonly<{ brainPath: string; endpoint: Endpoint }>) {
  return (
    <Link
      className="inline-flex items-center gap-1"
      href={`${brainPath}/${ENDPOINT_SEGMENTS[endpoint.kind]}/${endpoint.id}`}
    >
      <span className="text-muted-foreground">{endpoint.kind}</span>
      <PublicId value={endpoint.id} />
    </Link>
  );
}

export function BrainEntity({
  brainId,
  brainPath,
  entityId,
  organizationId,
}: Readonly<{ brainId: string; brainPath: string; entityId: string; organizationId: string }>) {
  const { edges, entity } = useSuspenseQuery(
    brainEntityQuery(organizationId, brainId, entityId),
  ).data;
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Heading level={2}>{entity.canonicalName}</Heading>
          <Badge color="zinc">{entity.kind}</Badge>
          <StatusBadge status={entity.status} />
          <StatusBadge status={entity.reviewStatus} />
        </div>
        <PublicId value={entity.id} />
      </div>
      <DescriptionList>
        <DescriptionTerm>Aliases</DescriptionTerm>
        <DescriptionDetails>
          {entity.normalizedAliases.length === 0 ? "None" : entity.normalizedAliases.join(", ")}
        </DescriptionDetails>
        {entity.mergedIntoEntityId ? (
          <>
            <DescriptionTerm>Merged into</DescriptionTerm>
            <DescriptionDetails>
              <EndpointLink
                brainPath={brainPath}
                endpoint={{ id: entity.mergedIntoEntityId, kind: "entity" }}
              />
            </DescriptionDetails>
          </>
        ) : null}
        <DescriptionTerm>Updated</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={entity.updatedAt} />
        </DescriptionDetails>
      </DescriptionList>
      <section className="flex flex-col gap-4">
        <Subheading>Edges</Subheading>
        {edges.length === 0 ? (
          <Text>No edges reference this entity.</Text>
        ) : (
          <Table striped>
            <TableHeader>
              <TableRow>
                <TableHead>From</TableHead>
                <TableHead>Relation</TableHead>
                <TableHead>To</TableHead>
                <TableHead>Confidence</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Lifecycle</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {edges.map((edge) => (
                <TableRow key={edge.id}>
                  <TableCell>
                    <EndpointLink brainPath={brainPath} endpoint={edge.from} />
                  </TableCell>
                  <TableCell>{edge.relation}</TableCell>
                  <TableCell>
                    <EndpointLink brainPath={brainPath} endpoint={edge.to} />
                  </TableCell>
                  <TableCell>{edge.confidence.toFixed(2)}</TableCell>
                  <TableCell>{edge.extractionMethod}</TableCell>
                  <TableCell>
                    <StatusBadge status={edge.lifecycle} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
