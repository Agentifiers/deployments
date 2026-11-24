import { DashboardSquare01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { liveReleaseId } from "../../apps/app-state.ts";
import { appPagesQuery } from "../../data/app-queries.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TextLink } from "@/components/ui/text";
import { ListEmpty, LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { StatusBadge } from "@/components/status-badge";

export function AppList({ scope }: Readonly<{ scope: EnvironmentScope }>) {
  const query = appPagesQuery(scope);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(query);
  const apps = data.pages.flatMap((page) => page.items);
  if (apps.length === 0) {
    return (
      <ListEmpty docs="/docs/capabilities/apps" icon={DashboardSquare01Icon} title="No apps">
        Agents create apps with the app.create tool.
      </ListEmpty>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <Table striped>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>URL</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Live release</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {apps.map((app) => {
            const live = liveReleaseId(app.lifecycle);
            return (
              <TableRow key={app.id}>
                <TableCell>
                  <TextLink href={`${environmentPath(scope)}/apps/${app.id}`}>{app.name}</TextLink>
                </TableCell>
                <TableCell>
                  <TextLink href={app.url} rel="noreferrer" target="_blank">
                    {app.url}
                  </TextLink>
                </TableCell>
                <TableCell>
                  <StatusBadge status={app.lifecycle.state} />
                </TableCell>
                <TableCell>{live === null ? "None" : <PublicId value={live} />}</TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={app.createdAt} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <LoadMore
        error={error}
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        queryKey={query.queryKey}
      />
    </div>
  );
}
