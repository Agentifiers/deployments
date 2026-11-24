import { Search01Icon } from "@hugeicons/core-free-icons";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { recordFeedbackFn, searchMemoriesFn } from "../../data/memory-mutations.ts";
import { activeSpacesQuery } from "../../data/memory-queries.ts";
import { PlatformApiError, UnauthenticatedError } from "../../errors.ts";
import { strategyLabel } from "../../memory/copy.ts";
import {
  SEARCH_STRATEGIES,
  searchRequest,
  USEFULNESS_RATINGS,
  type MemorySearchHit,
  type SearchDraft,
  type SearchMode,
  type Usefulness,
} from "../../memory/model.ts";
import { oneOf } from "../../observability/range.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Checkbox } from "@/components/ui/checkbox";
import {
  CheckboxField,
  Description,
  ErrorMessage,
  Field,
  FieldGroup,
  Fieldset,
  Label,
  Legend,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { toast } from "@/components/ui/sonner";
import { Text } from "@/components/ui/text";
import { ListEmpty } from "../list-controls.tsx";
import { PublicId } from "../public-id.tsx";
import { SearchNotEnabled } from "../search-not-enabled.tsx";
import { describeProblem, ProblemReference } from "../section-boundary.tsx";
import { MemoryContent } from "./memory-section.tsx";

const USEFULNESS_LABELS: Readonly<Record<Usefulness, string>> = {
  harmful: "Harmful",
  neutral: "Neutral",
  useful: "Useful",
};

function SearchProblem({ error }: Readonly<{ error: Error }>) {
  if (error instanceof PlatformApiError && error.problem.code === "memory_internal_error") {
    return <SearchNotEnabled surface="memory" />;
  }
  const problem = describeProblem(error, "Search failed");
  return (
    <Callout variant="destructive">
      <CalloutTitle>{problem.title}</CalloutTitle>
      <CalloutDescription>
        {problem.description ? <p>{problem.description}</p> : null}
        <ProblemReference requestId={problem.requestId} status={problem.status} />
      </CalloutDescription>
    </Callout>
  );
}

export function MemorySearch({ scope }: Readonly<{ scope: EnvironmentScope }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: spaces } = useSuspenseQuery(activeSpacesQuery(scope));
  const [draft, setDraft] = useState<SearchDraft>({
    memorySpaceIds: spaces.slice(0, 1).map((space) => space.id),
    mode: "policy",
    query: "",
    topK: "10",
  });
  const parsed = searchRequest(draft);
  const search = useMutation({
    mutationFn: () => {
      if (!parsed.ok) throw new TypeError(parsed.problem);
      return searchMemoriesFn({ data: { request: parsed.request, scope } });
    },
  });
  const { access } = shell;
  if (search.error instanceof UnauthenticatedError) throw search.error;
  if (spaces.length === 0) {
    return (
      <ListEmpty docs="/docs/capabilities/memory" icon={Search01Icon} title="No active spaces">
        Search reads active memory spaces. Create a space first.
      </ListEmpty>
    );
  }
  const modes: readonly SearchMode[] = access.strategySearchMemories
    ? ["policy", ...SEARCH_STRATEGIES]
    : ["policy"];
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (parsed.ok && !search.isPending) search.mutate();
  };
  return (
    <div className="flex flex-col gap-6">
      <form className="flex flex-col gap-6" onSubmit={submit}>
        <Field>
          <Label>Query</Label>
          <Input
            autoComplete="off"
            onChange={(event) => setDraft({ ...draft, query: event.target.value })}
            value={draft.query}
          />
        </Field>
        <Fieldset>
          <Legend>Spaces</Legend>
          <Text>Choose 1 to 20.</Text>
          <FieldGroup>
            {spaces.map((space) => {
              const checked = draft.memorySpaceIds.includes(space.id);
              return (
                <CheckboxField key={space.id}>
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(next) =>
                      setDraft({
                        ...draft,
                        memorySpaceIds: next
                          ? [...draft.memorySpaceIds, space.id]
                          : draft.memorySpaceIds.filter((id) => id !== space.id),
                      })
                    }
                  />
                  <Label>{space.name}</Label>
                </CheckboxField>
              );
            })}
          </FieldGroup>
        </Fieldset>
        <div className="grid gap-6 sm:grid-cols-2">
          <Field>
            <Label>Retrieval</Label>
            <Description>
              {draft.mode === "policy"
                ? "The strategy the environment's memory policy chooses."
                : "An evidence search with this strategy, whatever the policy says."}
            </Description>
            <NativeSelect
              onChange={(event) => {
                const mode = oneOf(modes, event.target.value);
                if (mode) setDraft({ ...draft, mode });
              }}
              value={draft.mode}
            >
              {modes.map((mode) => (
                <option key={mode} value={mode}>
                  {mode === "policy" ? "Policy" : strategyLabel(mode)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <Label>Results</Label>
            <Description>1 to 45.</Description>
            <Input
              inputMode="numeric"
              onChange={(event) => setDraft({ ...draft, topK: event.target.value })}
              value={draft.topK}
            />
          </Field>
        </div>
        {draft.query.trim() !== "" && !parsed.ok ? (
          <ErrorMessage>{parsed.problem}</ErrorMessage>
        ) : null}
        <div className="flex flex-wrap items-center gap-4">
          <Button disabled={!parsed.ok || search.isPending} type="submit">
            {search.isPending ? "Searching…" : "Search"}
          </Button>
          <Text>
            Each search makes a model call, plus a second one to rerank results under{" "}
            {strategyLabel("hybrid-rerank-v1")}, and the Quality tab counts it.
          </Text>
        </div>
      </form>
      {search.error ? <SearchProblem error={search.error} /> : null}
      {search.data ? (
        <SearchResults
          canRate={access.recordMemoryRetrievalFeedback}
          hits={search.data.hits}
          key={search.data.attemptId}
          scope={scope}
          strategy={search.data.strategy}
        />
      ) : null}
    </div>
  );
}

function SearchResults({
  canRate,
  hits,
  scope,
  strategy,
}: Readonly<{
  canRate: boolean;
  hits: readonly MemorySearchHit[];
  scope: EnvironmentScope;
  strategy: string;
}>) {
  if (hits.length === 0) {
    return <Text>No memories matched. Strategy: {strategyLabel(strategy)}.</Text>;
  }
  return (
    <section className="flex flex-col gap-4">
      <Text>
        {hits.length} {hits.length === 1 ? "result" : "results"}. Strategy:{" "}
        {strategyLabel(strategy)}.
      </Text>
      <ol className="flex flex-col divide-y divide-border">
        {hits.map((hit) => (
          <li className="flex flex-col gap-2 py-4" key={hit.memory.id}>
            <MemoryContent memory={hit.memory} />
            <div className="flex flex-wrap items-center gap-3 text-sm/6 text-muted-foreground">
              <span>Rank {hit.rank}</span>
              <span>Score {hit.score.toFixed(3)}</span>
              <PublicId value={hit.memory.id} />
              {canRate && hit.retrievalId !== undefined ? (
                <Feedback memoryId={hit.memory.id} retrievalId={hit.retrievalId} scope={scope} />
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Feedback({
  memoryId,
  retrievalId,
  scope,
}: Readonly<{ memoryId: string; retrievalId: string; scope: EnvironmentScope }>) {
  const mutation = useMutation({
    mutationFn: (usefulness: Usefulness) =>
      recordFeedbackFn({
        data: { idempotencyKey: crypto.randomUUID(), memoryId, retrievalId, scope, usefulness },
      }),
    onError: (error) => {
      const problem = describeProblem(error, "Feedback failed");
      toast.error(problem.title, { description: problem.description });
    },
  });
  if (mutation.error instanceof UnauthenticatedError) throw mutation.error;
  return (
    <div className="ml-auto flex items-center gap-2" role="group" aria-label="Rate this result">
      {USEFULNESS_RATINGS.map((usefulness) => (
        <Button
          disabled={mutation.isPending}
          key={usefulness}
          onClick={() => mutation.mutate(usefulness)}
          variant={mutation.data?.usefulness === usefulness ? "default" : "outline"}
        >
          {USEFULNESS_LABELS[usefulness]}
        </Button>
      ))}
    </div>
  );
}
