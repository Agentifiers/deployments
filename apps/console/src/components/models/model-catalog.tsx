import { AiBrain01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { MODEL_CAPABILITIES, MODEL_PROVIDERS } from "@deployments-ai/api-contract/models";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { modelPagesQuery } from "../../data/model-queries.ts";
import {
  CAPABILITY_LABELS,
  formatModelPrice,
  modelCapabilities,
  parseModelSearch,
  PROVIDER_LABELS,
  type ModelSearch,
} from "../../models/model-catalog-state.ts";
import { formatCompact } from "../../observability/format.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Badge } from "@/components/ui/badge";
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
import { Icon } from "../icon.tsx";
import { ListEmpty, FilterSelect, LoadMore } from "../list-controls.tsx";
import { SectionBoundary } from "../section-boundary.tsx";

const FLAG_OPTIONS = [
  { label: "yes", value: "true" },
  { label: "no", value: "false" },
] as const;

export function ModelCatalog({
  onSearch,
  scope,
  search,
}: Readonly<{
  onSearch: (search: ModelSearch) => void;
  scope: EnvironmentScope;
  search: ModelSearch;
}>) {
  const [text, setText] = useState(search.search ?? "");
  const change = (patch: Readonly<Partial<Record<keyof ModelSearch, string | undefined>>>) =>
    onSearch(parseModelSearch({ ...search, ...patch }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    change({ search: text });
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <FilterSelect
          label="Provider"
          onChange={(provider) => change({ provider })}
          options={MODEL_PROVIDERS.map((value) => ({ label: PROVIDER_LABELS[value], value }))}
          value={search.provider}
        />
        <FilterSelect
          label="Capability"
          onChange={(capability) => change({ capability })}
          options={MODEL_CAPABILITIES.map((value) => ({ label: CAPABILITY_LABELS[value], value }))}
          value={search.capability}
        />
        <FilterSelect
          label="Allowed here"
          onChange={(allowed) => change({ allowed })}
          options={FLAG_OPTIONS}
          value={search.allowed?.toString()}
        />
        <FilterSelect
          label="Curated"
          onChange={(curated) => change({ curated })}
          options={FLAG_OPTIONS}
          value={search.curated?.toString()}
        />
        <form className="flex items-center gap-2" onSubmit={submit}>
          <Input
            aria-label="Search models"
            maxLength={100}
            onChange={(event) => setText(event.target.value)}
            placeholder="Model ID or name"
            value={text}
          />
          <Button variant="outline" type="submit">
            <Icon icon={Search01Icon} />
            Search
          </Button>
        </form>
      </div>
      <SectionBoundary resetKey={JSON.stringify(search)}>
        <ModelTable scope={scope} search={search} />
      </SectionBoundary>
    </div>
  );
}

function ModelTable({ scope, search }: Readonly<{ scope: EnvironmentScope; search: ModelSearch }>) {
  const pagesQuery = modelPagesQuery(scope, search);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const items = data.pages.flatMap((page) => page.items);
  const source = data.pages[0]?.policy.source ?? "curated_defaults";
  return (
    <div className="flex flex-col gap-4">
      <Text>
        {source === "curated_defaults"
          ? "This environment runs the curated defaults: only curated models are allowed."
          : "This environment's model policy decides which models are allowed."}{" "}
        <TextLink href={`${environmentPath(scope)}/models/policy`}>Open the policy</TextLink>.
        Operator grants for one agent or workspace can still admit a model shown as not allowed.
      </Text>
      {items.length === 0 ? (
        <ListEmpty docs="/docs/capabilities/models" icon={AiBrain01Icon} title="No models match">
          Change or clear the filters.
        </ListEmpty>
      ) : (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Capabilities</TableHead>
              <TableHead className="text-right">Context</TableHead>
              <TableHead className="text-right">USD per 1M tokens in / out</TableHead>
              <TableHead>Here</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.modelId}>
                <TableCell>
                  <div className="flex flex-col">
                    {item.displayName === item.modelId ? null : <span>{item.displayName}</span>}
                    <Code className="w-fit">{item.modelId}</Code>
                  </div>
                </TableCell>
                <TableCell>{PROVIDER_LABELS[item.provider]}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {modelCapabilities(item).map((capability) => (
                      <Badge key={capability}>{CAPABILITY_LABELS[capability]}</Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCompact(item.contextWindowTokens)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatModelPrice(item) ?? "—"}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    <Badge color={item.allowed ? "green" : "zinc"}>
                      {item.allowed ? "allowed" : "not allowed"}
                    </Badge>
                    {item.curated ? <Badge color="sky">curated</Badge> : null}
                  </div>
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
