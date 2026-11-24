import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { systemDeploymentsQuery } from "../../data/system-queries.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code, Text } from "@/components/ui/text";
import { LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";

/** Recorded deployments, newest first, each with the release it pinned. */
export function SystemDeployments() {
  const pagesQuery = systemDeploymentsQuery();
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const deployments = data.pages.flatMap((page) => page.items);
  return (
    <div className="flex flex-col gap-4">
      {deployments.length === 0 ? (
        <Text>No deployment has been recorded for this install yet.</Text>
      ) : (
        <Table dense striped>
          <TableHeader>
            <TableRow>
              <TableHead>Deployed</TableHead>
              <TableHead>Source commit</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Release manifest</TableHead>
              <TableHead className="text-right">Artifacts</TableHead>
              <TableHead>Deployed by</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {deployments.map((deployment) => (
              <TableRow key={deployment.id}>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={deployment.deployedAt} />
                </TableCell>
                <TableCell>
                  <Code title={deployment.sourceCommit}>
                    {deployment.sourceCommit.slice(0, 12)}
                  </Code>
                </TableCell>
                <TableCell>
                  {deployment.targetName} · {deployment.profile}
                </TableCell>
                <TableCell>
                  <Code title={deployment.releaseManifestSha256}>
                    {deployment.releaseManifestSha256.slice(0, 12)}
                  </Code>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {deployment.lambdaArtifacts.length} Lambda · {deployment.images.length} image
                </TableCell>
                <TableCell className="max-w-64 truncate" title={deployment.deployedBy}>
                  {deployment.deployedBy}
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
