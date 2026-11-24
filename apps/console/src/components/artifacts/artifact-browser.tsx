import { Cancel01Icon, File01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { useQueryClient, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  CONTENT_TYPE_FILTERS,
  hasArtifactFilters,
  type ArtifactFilters,
} from "../../artifacts/filters.ts";
import { artifactPagesQuery } from "../../data/thread-queries.ts";
import { localDay, localDayBound, parseRuntimeId } from "../../runs/filters.ts";
import { formatByteSize } from "../../runs/views.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code, Text, TextLink } from "@/components/ui/text";
import { DatePicker } from "../date-picker.tsx";
import { Icon } from "../icon.tsx";
import { FilterSelect, ListEmpty, LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { StatusBadge } from "@/components/status-badge";

export type ArtifactFilterPatch = {
  readonly [Key in keyof ArtifactFilters]?: ArtifactFilters[Key] | undefined;
};

function DayFilter({
  bound,
  label,
  onChange,
  value,
}: Readonly<{
  bound: "end" | "start";
  label: string;
  onChange: (instant: string | undefined) => void;
  value: string | undefined;
}>) {
  return (
    <label className="flex items-center gap-2 text-sm/6 whitespace-nowrap text-muted-foreground">
      {label}
      <span className="w-40">
        <DatePicker
          label={label}
          onChange={(day) => onChange(localDayBound(day, bound))}
          value={value ? localDay(value) : ""}
        />
      </span>
    </label>
  );
}

/** A text filter applied on Enter or blur, so each keystroke does not refetch the list. */
function TextFilter({
  label,
  onChange,
  parse,
  value,
}: Readonly<{
  label: string;
  onChange: (value: string | undefined) => void;
  parse: (text: string) => string | undefined;
  value: string | undefined;
}>) {
  const [text, setText] = useState(value ?? "");
  const parsed = parse(text);
  const apply = () => {
    if (text.trim() === "") onChange(undefined);
    else if (parsed !== undefined) onChange(parsed);
  };
  return (
    <div className="w-56">
      <Input
        aria-invalid={text.trim() !== "" && parsed === undefined}
        aria-label={label}
        autoComplete="off"
        onBlur={apply}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") apply();
        }}
        placeholder={label}
        value={text}
      />
    </div>
  );
}

const typeFilter = (text: string) => {
  const trimmed = text.trim();
  return trimmed && trimmed.length <= 100 ? trimmed : undefined;
};

/**
 * Every artifact in the environment, newest first, with the filters the API applies. `onUpload`
 * opens the page's upload dialog; an empty list offers it when the caller may upload.
 */
export function ArtifactBrowser({
  filters,
  onFilter,
  onUpload,
  scope,
}: Readonly<{
  filters: ArtifactFilters;
  onFilter: (patch: ArtifactFilterPatch) => void;
  onUpload?: (() => void) | undefined;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const pagesQuery = artifactPagesQuery(scope, { filters, kind: "environment" });
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const artifacts = data.pages.flatMap((page) => page.items);
  const base = environmentPath(scope);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <TextFilter
          key={`type-${filters.type ?? ""}`}
          label="Type, such as report"
          onChange={(type) => onFilter({ type })}
          parse={typeFilter}
          value={filters.type}
        />
        <FilterSelect
          label="Content"
          onChange={(contentType) => onFilter({ contentType })}
          options={CONTENT_TYPE_FILTERS}
          value={filters.contentType}
        />
        <TextFilter
          key={`run-${filters.runId ?? ""}`}
          label="Run ID"
          onChange={(runId) => onFilter({ runId })}
          parse={parseRuntimeId}
          value={filters.runId}
        />
        <TextFilter
          key={`thread-${filters.threadId ?? ""}`}
          label="Thread ID"
          onChange={(threadId) => onFilter({ threadId })}
          parse={parseRuntimeId}
          value={filters.threadId}
        />
        <DayFilter
          bound="start"
          label="Created from"
          onChange={(createdAfter) => onFilter({ createdAfter })}
          value={filters.createdAfter}
        />
        <DayFilter
          bound="end"
          label="Created through"
          onChange={(createdBefore) => onFilter({ createdBefore })}
          value={filters.createdBefore}
        />
        {hasArtifactFilters(filters) ? (
          <Button
            onClick={() =>
              onFilter({
                contentType: undefined,
                createdAfter: undefined,
                createdBefore: undefined,
                runId: undefined,
                threadId: undefined,
                type: undefined,
              })
            }
            variant="ghost"
          >
            <Icon icon={Cancel01Icon} />
            Clear filters
          </Button>
        ) : null}
        <Button
          className="ml-auto"
          onClick={() => void queryClient.resetQueries({ queryKey: pagesQuery.queryKey })}
          variant="outline"
        >
          <Icon icon={RefreshIcon} />
          Refresh
        </Button>
      </div>
      <Text>Newest first. Lists only the artifacts you can read.</Text>
      {artifacts.length > 0 ? (
        <Table dense striped>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Content</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Run</TableHead>
              <TableHead>Thread</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {artifacts.map((artifact) => (
              <TableRow key={artifact.artifactId}>
                <TableCell className="max-w-64 truncate">
                  <TextLink
                    href={`${base}/artifacts/${artifact.artifactId}`}
                    title={artifact.fileName ?? artifact.name}
                  >
                    {artifact.name}
                  </TextLink>
                </TableCell>
                <TableCell>{artifact.type}</TableCell>
                <TableCell>
                  <Code>{artifact.contentType}</Code>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatByteSize(artifact.byteSize)}
                </TableCell>
                <TableCell>
                  <StatusBadge status={artifact.status} />
                </TableCell>
                <TableCell>
                  {artifact.runId ? (
                    <TextLink href={`${base}/runs/${artifact.runId}`} title={artifact.runId}>
                      <Code>…{artifact.runId.slice(-8)}</Code>
                    </TextLink>
                  ) : null}
                </TableCell>
                <TableCell>
                  {artifact.threadId ? (
                    <TextLink
                      href={`${base}/threads/${artifact.threadId}`}
                      title={artifact.threadId}
                    >
                      <Code>…{artifact.threadId.slice(-8)}</Code>
                    </TextLink>
                  ) : null}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={artifact.createdAt} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : hasNextPage ? (
        <Text>No matching artifacts in the pages read so far. Load more to keep searching.</Text>
      ) : (
        <ListEmpty
          action={
            onUpload ? (
              <Button onClick={onUpload} variant="outline">
                Upload a file
              </Button>
            ) : undefined
          }
          docs="/docs/capabilities/artifacts"
          icon={File01Icon}
          title={hasArtifactFilters(filters) ? "No matching artifacts" : "No artifacts yet"}
        >
          {hasArtifactFilters(filters)
            ? "Clear the filters to see every artifact in this environment."
            : "Runs store files here when a tool produces one, and you can upload files to give a run as input."}
        </ListEmpty>
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
