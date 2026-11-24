import { TestTube01Icon, Wrench01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { ClientOnly } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { TOOL_CATALOG_STATUS_FILTERS } from "@deployments-ai/api-contract/tool-catalog";
import { toolPagesQuery, toolQuery } from "../../data/tool-policy-queries.ts";
import { oneOf } from "../../observability/range.ts";
import type { EnvironmentScope } from "../../scope.ts";
import type { ToolCatalogItem } from "../../server/tool-catalog-data.ts";
import type { CatalogSearch } from "../../tool-policies/catalog-state.ts";
import { CodeBlock } from "@/components/reui/code-block/code-block";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
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
import { ListEmpty, LoadMore } from "../list-controls.tsx";
import { SectionBoundary, SectionSkeleton } from "../section-boundary.tsx";
import { StatusBadge } from "@/components/status-badge";

const BINDING_LABELS: Readonly<Record<"catalog" | "connection" | "none", string>> = {
  catalog: "Catalog default",
  connection: "Tool policy",
  none: "No binding",
};

function FilterForm({
  onSearch,
  search,
}: Readonly<{ onSearch: (search: CatalogSearch) => void; search: CatalogSearch }>) {
  const [provider, setProvider] = useState(search.provider ?? "");
  const [prefix, setPrefix] = useState(search.prefix ?? "");
  const [text, setText] = useState(search.search ?? "");
  const [status, setStatus] = useState(search.status ?? "active");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSearch({ prefix, provider, search: text, status });
  };
  return (
    <form className="grid gap-4 sm:grid-cols-5 sm:items-end" onSubmit={submit}>
      <Field>
        <Label>Search</Label>
        <Input onChange={(event) => setText(event.target.value)} value={text} />
      </Field>
      <Field>
        <Label>Name prefix</Label>
        <Input
          className="font-mono"
          onChange={(event) => setPrefix(event.target.value)}
          placeholder="github."
          value={prefix}
        />
      </Field>
      <Field>
        <Label>Provider</Label>
        <Input
          className="font-mono"
          onChange={(event) => setProvider(event.target.value)}
          placeholder="github"
          value={provider}
        />
      </Field>
      <Field>
        <Label>Status</Label>
        <NativeSelect
          onChange={(event) =>
            setStatus(oneOf(TOOL_CATALOG_STATUS_FILTERS, event.target.value) ?? "active")
          }
          value={status}
        >
          {TOOL_CATALOG_STATUS_FILTERS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Button variant="outline" type="submit">
        Apply
      </Button>
    </form>
  );
}

function Schema({ label, value }: Readonly<{ label: string; value: unknown }>) {
  return (
    <section className="flex flex-col gap-2">
      <Text className="font-medium">{label}</Text>
      {value === undefined ? (
        <Text>None declared.</Text>
      ) : (
        <CodeBlock
          code={JSON.stringify(value, null, 2)}
          label={label}
          language="json"
          maxLines={15}
        />
      )}
    </section>
  );
}

function ToolDetail({ scope, toolName }: Readonly<{ scope: EnvironmentScope; toolName: string }>) {
  const { data: tool } = useSuspenseQuery(toolQuery(scope, toolName));
  return (
    <div className="flex flex-col gap-6">
      <Text>{tool.description}</Text>
      <DescriptionList>
        <DescriptionTerm>Category</DescriptionTerm>
        <DescriptionDetails>{tool.category}</DescriptionDetails>
        <DescriptionTerm>Effect</DescriptionTerm>
        <DescriptionDetails>{tool.effect}</DescriptionDetails>
        <DescriptionTerm>Default action</DescriptionTerm>
        <DescriptionDetails>
          <StatusBadge status={tool.defaultPolicyAction} />
        </DescriptionDetails>
        <DescriptionTerm>Decided by</DescriptionTerm>
        <DescriptionDetails>{BINDING_LABELS[tool.policyBinding ?? "none"]}</DescriptionDetails>
        <DescriptionTerm>Provider</DescriptionTerm>
        <DescriptionDetails>{tool.providerKey ?? "None"}</DescriptionDetails>
        <DescriptionTerm>Required scopes</DescriptionTerm>
        <DescriptionDetails>
          {tool.requiredScopes.length === 0 ? "None" : <Code>{tool.requiredScopes.join(" ")}</Code>}
        </DescriptionDetails>
        <DescriptionTerm>Route</DescriptionTerm>
        <DescriptionDetails>{tool.route}</DescriptionDetails>
        <DescriptionTerm>Status</DescriptionTerm>
        <DescriptionDetails>
          <StatusBadge status={tool.status} />
        </DescriptionDetails>
      </DescriptionList>
      <Schema label="Input schema" value={tool.inputSchema} />
      <Schema label="Output schema" value={tool.outputSchema} />
    </div>
  );
}

function ToolRows({
  onOpen,
  onToggle,
  scope,
  search,
  selected,
}: Readonly<{
  onOpen: (toolName: string) => void;
  onToggle: (tool: ToolCatalogItem, checked: boolean) => void;
  scope: EnvironmentScope;
  search: CatalogSearch;
  selected: ReadonlySet<string>;
}>) {
  const pagesQuery = toolPagesQuery(scope, search);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const tools = data.pages.flatMap((page) => page.items);
  if (tools.length === 0) {
    return (
      <ListEmpty docs="/docs/capabilities/tools" icon={Wrench01Icon} title="No matching tools">
        The catalog lists the platform's own tools. Change the filters to see more.
      </ListEmpty>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <Table dense striped>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <span className="sr-only">Select</span>
            </TableHead>
            <TableHead>Tool</TableHead>
            <TableHead>Effect</TableHead>
            <TableHead>Default</TableHead>
            <TableHead>Decided by</TableHead>
            <TableHead>Provider</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tools.map((tool) => (
            <TableRow key={tool.name}>
              <TableCell>
                <Checkbox
                  aria-label={`Select ${tool.name}`}
                  checked={selected.has(tool.name)}
                  onCheckedChange={(checked) => onToggle(tool, checked)}
                />
              </TableCell>
              {/* Wrapping names and a clamped (not nowrap) description let this column narrow,
                  so the table fits instead of clipping Status at its scroll edge. */}
              <TableCell className="min-w-56 whitespace-normal">
                <button
                  className="text-left font-mono text-sm/6 wrap-anywhere underline decoration-foreground/20 hover:decoration-foreground"
                  onClick={() => onOpen(tool.name)}
                  type="button"
                >
                  {tool.name}
                </button>
                <div
                  className="line-clamp-1 max-w-xl text-xs/5 text-muted-foreground"
                  title={tool.description}
                >
                  {tool.description}
                </div>
              </TableCell>
              <TableCell>{tool.effect}</TableCell>
              <TableCell>
                <StatusBadge status={tool.defaultPolicyAction} />
              </TableCell>
              <TableCell>{BINDING_LABELS[tool.policyBinding ?? "none"]}</TableCell>
              <TableCell>{tool.providerKey ?? "None"}</TableCell>
              <TableCell>
                <StatusBadge status={tool.status} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
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

export function ToolCatalog({
  canSimulate,
  onSearch,
  onSimulate,
  scope,
  search,
}: Readonly<{
  canSimulate: boolean;
  onSearch: (search: CatalogSearch) => void;
  onSimulate: (toolNames: readonly string[]) => void;
  scope: EnvironmentScope;
  search: CatalogSearch;
}>) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const { tool, ...filters } = search;
  return (
    <div className="flex flex-col gap-6">
      <Text>
        Tools the platform provides. Policies decide connection tools. Platform, hosted code, and
        client tools follow their own default. Your environment's extension tools are not listed
        here.
      </Text>
      <FilterForm key={JSON.stringify(filters)} onSearch={onSearch} search={filters} />
      {canSimulate ? (
        <div className="flex flex-wrap items-center gap-3">
          <Text>
            {selected.size === 0
              ? "Check tools to simulate a policy on them."
              : `${selected.size} ${selected.size === 1 ? "tool" : "tools"} checked.`}
          </Text>
          <Button
            className="ml-auto"
            disabled={selected.size === 0}
            onClick={() => onSimulate([...selected])}
            variant="outline"
          >
            <Icon icon={TestTube01Icon} />
            Simulate
          </Button>
        </div>
      ) : null}
      <SectionBoundary resetKey={JSON.stringify(filters)}>
        <ToolRows
          onOpen={(toolName) => onSearch({ ...filters, tool: toolName })}
          onToggle={(entry, checked) =>
            setSelected((current) => {
              const next = new Set(current);
              if (checked) next.add(entry.name);
              else next.delete(entry.name);
              return next;
            })
          }
          scope={scope}
          search={filters}
          selected={selected}
        />
      </SectionBoundary>
      <Sheet onOpenChange={() => onSearch(filters)} open={tool !== undefined}>
        <SheetContent className="sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle className="font-mono">{tool}</SheetTitle>
          </SheetHeader>
          <SheetBody>
            {tool === undefined ? null : (
              <ClientOnly fallback={<SectionSkeleton />}>
                <SectionBoundary resetKey={tool}>
                  <ToolDetail scope={scope} toolName={tool} />
                </SectionBoundary>
              </ClientOnly>
            )}
          </SheetBody>
        </SheetContent>
      </Sheet>
    </div>
  );
}
