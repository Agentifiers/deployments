import type { IconSvgElement } from "@hugeicons/react";
import { useQuery, useQueryClient, useSuspenseQuery, type QueryKey } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { agentDirectoryQuery, releaseFilterQuery } from "../data/observability-queries.ts";
import { PlatformApiError } from "../errors.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { NativeSelect } from "@/components/ui/native-select";
import { DocsLink } from "./docs-link.tsx";
import { Icon } from "./icon.tsx";

export function FilterSelect({
  disabled = false,
  label,
  onChange,
  options,
  value,
}: Readonly<{
  disabled?: boolean;
  label: string;
  onChange: (value: string | undefined) => void;
  options: readonly { readonly label: string; readonly value: string }[];
  value: string | undefined;
}>) {
  return (
    <div className="w-56">
      <NativeSelect
        aria-label={label}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || undefined)}
        value={value ?? ""}
      >
        <option value="">{label}: any</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {label}: {option.label}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

export function LoadMore({
  error,
  fetchNextPage,
  hasNextPage,
  isFetchingNextPage,
  queryKey,
}: Readonly<{
  error: Error | null;
  fetchNextPage: () => unknown;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  queryKey: QueryKey;
}>) {
  const queryClient = useQueryClient();
  if (error instanceof PlatformApiError && error.problem.status === 410) {
    return (
      <p className="text-sm/6 text-muted-foreground">
        This list's cursor expired.{" "}
        <button
          className="font-medium text-foreground underline"
          onClick={() => void queryClient.resetQueries({ queryKey })}
          type="button"
        >
          Reload from the start
        </button>
        .
      </p>
    );
  }
  return (
    <>
      {error ? <p className="text-sm/6 text-destructive">{error.message}</p> : null}
      {hasNextPage ? (
        <div>
          <Button
            disabled={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
            variant="outline"
          >
            {isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </>
  );
}

/**
 * An empty list: what would appear here, the console action that adds it when the caller may use
 * one, and the guide that explains it.
 */
export function ListEmpty({
  action,
  children,
  docs,
  icon,
  title,
}: Readonly<{
  action?: ReactNode;
  children?: ReactNode;
  docs?: `/docs/${string}`;
  icon: IconSvgElement;
  title: string;
}>) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon icon={icon} />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {children || docs ? (
          <EmptyDescription>
            {children}
            {children && docs ? " " : null}
            {docs ? <DocsLink path={docs} /> : null}
          </EmptyDescription>
        ) : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}

export function ReleaseFilter({
  definitionId,
  label,
  onChange,
  scope,
  value,
}: Readonly<{
  definitionId: string | undefined;
  label: string;
  onChange: (releaseId: string | undefined) => void;
  scope: EnvironmentScope;
  value: string | undefined;
}>) {
  const { data: directory } = useSuspenseQuery(agentDirectoryQuery(scope));
  const [chosenDefinitionId, setChosenDefinitionId] = useState<string>();
  const agentId = chosenDefinitionId ?? definitionId;
  const releases = useQuery({
    ...releaseFilterQuery(scope, agentId ?? ""),
    enabled: agentId !== undefined,
  });
  const definitions = directory.definitions
    .map((entry) => ({ label: entry.name, value: entry.id }))
    .toSorted((left, right) => left.label.localeCompare(right.label));
  return (
    <>
      <FilterSelect
        label={`${label} agent`}
        onChange={(next) => {
          setChosenDefinitionId(next ?? "");
          onChange(undefined);
        }}
        options={definitions}
        value={agentId || undefined}
      />
      <FilterSelect
        disabled={!agentId}
        label={label}
        onChange={onChange}
        options={(releases.data ?? []).map((release) => ({
          label: `#${release.releaseNumber}`,
          value: release.id,
        }))}
        value={value}
      />
    </>
  );
}
