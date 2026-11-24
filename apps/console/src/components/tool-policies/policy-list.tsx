import { PolicyIcon } from "@hugeicons/core-free-icons";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { policyPagesQuery } from "../../data/tool-policy-queries.ts";
import { formatExact } from "../../observability/format.ts";
import { oneOf } from "../../observability/range.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { POLICY_VIEWS, type PolicyView } from "../../tool-policies/policy-state.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Text } from "@/components/ui/text";
import { SingleToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ListEmpty, LoadMore } from "../list-controls.tsx";
import { useListCreateAction } from "../list-create-action.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { StatusBadge } from "@/components/status-badge";

const VIEW_LABELS: Readonly<Record<PolicyView, string>> = { active: "Active", all: "All" };

export function PolicyList({
  onView,
  scope,
  view,
}: Readonly<{ onView: (view: PolicyView) => void; scope: EnvironmentScope; view: PolicyView }>) {
  return (
    <div className="flex flex-col gap-4">
      <SingleToggleGroup
        aria-label="Policies shown"
        className="self-start"
        onValueChange={(next) => {
          const nextView = oneOf(POLICY_VIEWS, next);
          if (nextView) onView(nextView);
        }}
        size="sm"
        value={view}
      >
        {POLICY_VIEWS.map((option) => (
          <ToggleGroupItem key={option} value={option}>
            {VIEW_LABELS[option]}
          </ToggleGroupItem>
        ))}
      </SingleToggleGroup>
      <SectionBoundary resetKey={view}>
        <PolicyTable scope={scope} view={view} />
      </SectionBoundary>
    </div>
  );
}

function PolicyTable({ scope, view }: Readonly<{ scope: EnvironmentScope; view: PolicyView }>) {
  const createAction = useListCreateAction();
  const pagesQuery = policyPagesQuery(scope, view);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const policies = data.pages.flatMap((page) => page.policies);
  const first = data.pages[0];
  const hidden = first?.hidden ?? 0;
  const basePath = `${environmentPath(scope)}/tool-policies`;
  return (
    <div className="flex flex-col gap-4">
      {view === "active" ? (
        <Text>
          {hidden > 0
            ? `${formatExact(hidden)} archived ${hidden === 1 ? "policy is" : "policies are"} hidden.`
            : "Archived policies are hidden."}
        </Text>
      ) : null}
      {first?.complete === false ? (
        <Text>The environment has more policies than the console reads; this list is partial.</Text>
      ) : null}
      {policies.length === 0 ? (
        <ListEmpty
          action={createAction}
          docs="/docs/capabilities/tools"
          icon={PolicyIcon}
          title={hidden > 0 ? "No active tool policies" : "No tool policies"}
        >
          A tool policy allows, denies, or asks approval for an agent's connection tools. A
          deployment applies one by pinning it to a tool.
        </ListEmpty>
      ) : (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Rules</TableHead>
              <TableHead>Default</TableHead>
              <TableHead className="text-right">Version</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead>ID</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {policies.map((policy) => (
              <TableRow href={`${basePath}/${policy.id}`} key={policy.id} title={policy.name}>
                <TableCell>
                  {policy.name}
                  {policy.description ? (
                    <div className="max-w-96 truncate text-xs/5 text-muted-foreground">
                      {policy.description}
                    </div>
                  ) : null}
                </TableCell>
                <TableCell>
                  <StatusBadge status={policy.status} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatExact(policy.policy.rules.length)}
                </TableCell>
                <TableCell>
                  {policy.policy.defaultAction ? (
                    <StatusBadge status={policy.policy.defaultAction} />
                  ) : (
                    "Tool default"
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{policy.version}</TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={policy.updatedAt} />
                </TableCell>
                <TableCell>
                  <PublicId value={policy.id} />
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
