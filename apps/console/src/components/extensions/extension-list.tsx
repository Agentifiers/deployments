import { PuzzleIcon } from "@hugeicons/core-free-icons";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { extensionPagesQuery } from "../../data/extension-queries.ts";
import {
  EXTENSION_KINDS,
  EXTENSION_VIEWS,
  KIND_LABELS,
  type ExtensionSearch,
  type ExtensionView,
} from "../../extensions/extension-state.ts";
import { formatExact } from "../../observability/format.ts";
import { oneOf } from "../../observability/range.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
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
import { ListEmpty, FilterSelect, LoadMore } from "../list-controls.tsx";
import { PublicId } from "../public-id.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { StatusBadge } from "@/components/status-badge";

const VIEW_LABELS: Readonly<Record<ExtensionView, string>> = { active: "Active", all: "All" };

export function ExtensionList({
  emptyAction,
  onSearch,
  scope,
  search,
}: Readonly<{
  emptyAction?: ReactNode;
  onSearch: (search: ExtensionSearch) => void;
  scope: EnvironmentScope;
  search: ExtensionSearch;
}>) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <SingleToggleGroup
          aria-label="Extensions shown"
          onValueChange={(next) => {
            const view = oneOf(EXTENSION_VIEWS, next);
            if (view) {
              onSearch({
                ...(view === "all" ? { show: "all" } : {}),
                ...(search.type ? { type: search.type } : {}),
              });
            }
          }}
          size="sm"
          value={search.show ?? "active"}
        >
          {EXTENSION_VIEWS.map((option) => (
            <ToggleGroupItem key={option} value={option}>
              {VIEW_LABELS[option]}
            </ToggleGroupItem>
          ))}
        </SingleToggleGroup>
        <FilterSelect
          label="Type"
          onChange={(value) => {
            const type = oneOf(EXTENSION_KINDS, value);
            onSearch({ ...(search.show ? { show: search.show } : {}), ...(type ? { type } : {}) });
          }}
          options={EXTENSION_KINDS.map((kind) => ({ label: KIND_LABELS[kind], value: kind }))}
          value={search.type}
        />
      </div>
      <SectionBoundary resetKey={`${search.show ?? "active"}:${search.type ?? ""}`}>
        <ExtensionTable emptyAction={emptyAction} scope={scope} search={search} />
      </SectionBoundary>
    </div>
  );
}

function ExtensionTable({
  emptyAction,
  scope,
  search,
}: Readonly<{ emptyAction: ReactNode; scope: EnvironmentScope; search: ExtensionSearch }>) {
  const pagesQuery = extensionPagesQuery(scope, search);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const extensions = data.pages.flatMap((page) => page.extensions);
  const hidden = data.pages[0]?.hidden ?? 0;
  const cappedAt = data.pages[0]?.cappedAt;
  const basePath = `${environmentPath(scope)}/extensions`;
  return (
    <div className="flex flex-col gap-4">
      {cappedAt === undefined ? null : (
        <Text>
          This environment has more extensions than the console reads. The list shows the first{" "}
          {formatExact(cappedAt)}.
        </Text>
      )}
      {search.show === undefined && hidden > 0 ? (
        <Text>
          {formatExact(hidden)} archived {hidden === 1 ? "extension is" : "extensions are"} hidden.
        </Text>
      ) : null}
      {extensions.length === 0 ? (
        <ListEmpty
          action={search.type === undefined ? emptyAction : undefined}
          docs="/docs/capabilities/extensions-and-hosted-code"
          icon={PuzzleIcon}
          title="No extensions"
        >
          An extension is a tool you register so agents can call it beside the platform catalog.
        </ListEmpty>
      ) : (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Effect</TableHead>
              <TableHead>Default action</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>ID</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {extensions.map((extension) => (
              <TableRow
                href={`${basePath}/${extension.id}`}
                key={extension.id}
                title={extension.name}
              >
                <TableCell className="font-mono">{extension.name}</TableCell>
                <TableCell>{KIND_LABELS[extension.execution.type]}</TableCell>
                <TableCell>{extension.effect}</TableCell>
                <TableCell>
                  <StatusBadge status={extension.defaultPolicyAction} />
                </TableCell>
                <TableCell>
                  <StatusBadge status={extension.status} />
                </TableCell>
                <TableCell>
                  <PublicId value={extension.id} />
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
