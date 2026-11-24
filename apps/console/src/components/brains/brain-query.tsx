import type { BrainResponse } from "@deployments-ai/api-contract/brains";
import { useMutation, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import {
  chosenBrains,
  citationKey,
  joinClaims,
  MAX_FEEDBACK_LENGTH,
  MAX_QUERY_BRAINS,
  MAX_QUERY_LENGTH,
  QUERY_COST,
  searchNotEnabled,
  USEFULNESS,
  type BrainAnswer,
  type BrainCitation,
  type BrainFeedback,
  type BrainQueryMode,
  type BrainQueryResult,
  type BrainSearchResults,
  type FeedbackBody,
  type Usefulness,
} from "../../brains/query.ts";
import { askBrainsFn, recordBrainFeedbackFn, searchBrainsFn } from "../../data/brain-mutations.ts";
import { brainListQuery } from "../../data/brain-queries.ts";
import { UnauthenticatedError } from "../../errors.ts";
import { oneOf } from "../../observability/range.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Checkbox } from "@/components/ui/checkbox";
import {
  CheckboxField,
  Description,
  Field,
  Fieldset,
  Label,
  Legend,
  RadioField,
} from "@/components/ui/field";
import { Subheading } from "@/components/ui/heading";
import { Link } from "@/components/ui/link";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Code, Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { ActionDialog } from "../action-dialog.tsx";
import { useKeyedSnapshot } from "../keyed-snapshot.ts";
import { LoadMore } from "../list-controls.tsx";
import { PublicId } from "../public-id.tsx";
import { SearchNotEnabled } from "../search-not-enabled.tsx";
import { describeProblem, ProblemReference } from "../section-boundary.tsx";

const MODES = ["search", "ask"] as const satisfies readonly BrainQueryMode[];

const MODE_LABELS: Readonly<Record<BrainQueryMode, string>> = { ask: "Ask", search: "Search" };

interface Submitted {
  readonly brainIds: readonly string[];
  readonly mode: BrainQueryMode;
  readonly text: string;
}

export function BrainQuery({
  preselected,
  scope,
}: Readonly<{ preselected: string | undefined; scope: EnvironmentScope }>) {
  const listQuery = brainListQuery(scope.organizationId);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(listQuery);
  const brains = data.pages.flatMap((page) => page.items);
  const [selected, setSelected] = useState<readonly string[]>(preselected ? [preselected] : []);
  const [mode, setMode] = useState<BrainQueryMode>("search");
  const [text, setText] = useState("");
  const query = useMutation({
    mutationFn: ({ brainIds, mode: submitted, text: asked }: Submitted) => {
      const request = { idempotencyKey: crypto.randomUUID(), scope };
      return submitted === "ask"
        ? askBrainsFn({ data: { ...request, body: { brainIds: [...brainIds], question: asked } } })
        : searchBrainsFn({ data: { ...request, body: { brainIds: [...brainIds], query: asked } } });
    },
  });
  if (query.error instanceof UnauthenticatedError) throw query.error;
  const names = new Map(brains.map((brain) => [brain.id, brain.name]));
  const chosen = chosenBrains(selected, names);
  const ready = chosen.length > 0 && text.trim() !== "" && !query.isPending;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) query.mutate({ brainIds: chosen, mode, text: text.trim() });
  };
  return (
    <div className="flex flex-col gap-10">
      <form className="flex flex-col gap-6" onSubmit={submit}>
        <BrainPicker brains={brains} onChange={setSelected} value={chosen} />
        <LoadMore
          error={error}
          fetchNextPage={fetchNextPage}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          queryKey={listQuery.queryKey}
        />
        <Fieldset>
          <Legend>Mode</Legend>
          <RadioGroup
            onValueChange={(value: string) => {
              const next = oneOf(MODES, value);
              if (next) setMode(next);
            }}
            value={mode}
          >
            <RadioField>
              <RadioGroupItem value="search" />
              <Label>Search</Label>
              <Description>Returns matching excerpts from the documents.</Description>
            </RadioField>
            <RadioField>
              <RadioGroupItem value="ask" />
              <Label>Ask</Label>
              <Description>Answers a question with claims that cite the documents.</Description>
            </RadioField>
          </RadioGroup>
        </Fieldset>
        <Field>
          <Label>{mode === "ask" ? "Question" : "Query"}</Label>
          <Textarea
            maxLength={MAX_QUERY_LENGTH}
            onChange={(event) => setText(event.target.value)}
            rows={3}
            value={text}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-4">
          <Button disabled={!ready} type="submit">
            {query.isPending ? "Working…" : MODE_LABELS[mode]}
          </Button>
          <Text className="flex-1">{QUERY_COST[mode]}</Text>
        </div>
      </form>
      {query.error ? (
        searchNotEnabled(query.error) ? (
          <div className="flex flex-col gap-2">
            <SearchNotEnabled surface="brains" />
            <ProblemReference {...describeProblem(query.error, "The query failed")} />
          </div>
        ) : (
          <QueryProblem error={query.error} />
        )
      ) : null}
      {query.data ? (
        <QueryResult
          key={queryAttemptOf(query.data)}
          names={names}
          result={query.data}
          scope={scope}
        />
      ) : null}
    </div>
  );
}

function queryAttemptOf(result: BrainQueryResult): string {
  return result.mode === "ask" ? result.answer.queryAttemptId : result.results.queryAttemptId;
}

function BrainPicker({
  brains,
  onChange,
  value,
}: Readonly<{
  brains: readonly BrainResponse[];
  onChange: (ids: readonly string[]) => void;
  value: readonly string[];
}>) {
  const full = value.length >= MAX_QUERY_BRAINS;
  return (
    <Fieldset>
      <Legend>Brains</Legend>
      <Text>
        Choose up to {MAX_QUERY_BRAINS} of the Brains you can read. {value.length} chosen.
      </Text>
      {brains.length === 0 ? (
        <Text>You cannot read any Brain yet.</Text>
      ) : (
        <div className="grid max-h-72 gap-3 overflow-y-auto rounded-lg border border-border p-3 sm:grid-cols-2">
          {brains.map((brain) => {
            const checked = value.includes(brain.id);
            return (
              <CheckboxField disabled={full && !checked} key={brain.id}>
                <Checkbox
                  checked={checked}
                  onCheckedChange={(next) =>
                    onChange(next ? [...value, brain.id] : value.filter((id) => id !== brain.id))
                  }
                />
                <Label>{brain.name}</Label>
                <Description>
                  <Code>{brain.slug}</Code>
                </Description>
              </CheckboxField>
            );
          })}
        </div>
      )}
    </Fieldset>
  );
}

function QueryProblem({ error }: Readonly<{ error: Error }>) {
  const problem = describeProblem(error, "The query failed");
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

type Names = ReadonlyMap<string, string>;

function QueryResult({
  names,
  result,
  scope,
}: Readonly<{ names: Names; result: BrainQueryResult; scope: EnvironmentScope }>) {
  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Subheading>{result.mode === "ask" ? "Answer" : "Results"}</Subheading>
        <Text>
          Query <PublicId value={queryAttemptOf(result)} />
        </Text>
        <Feedback queryAttemptId={queryAttemptOf(result)} scope={scope} />
      </div>
      {result.mode === "ask" ? (
        <Answer answer={result.answer} names={names} scope={scope} />
      ) : (
        <SearchHits names={names} results={result.results} scope={scope} />
      )}
    </section>
  );
}

function documentHref(scope: EnvironmentScope, citation: BrainCitation) {
  return `${environmentPath(scope)}/brains/${citation.brainId}/documents/${citation.documentId}`;
}

function SearchHits({
  names,
  results,
  scope,
}: Readonly<{ names: Names; results: BrainSearchResults; scope: EnvironmentScope }>) {
  if (results.results.length === 0) {
    return <Text>No indexed evidence matched. Documents appear in results once indexed.</Text>;
  }
  return (
    <ol className="flex flex-col gap-4">
      {results.results.map((hit) => (
        <li
          className="flex flex-col gap-2 rounded-lg border border-border p-4"
          key={citationKey(hit.citation)}
        >
          <div className="flex flex-wrap items-center gap-3">
            <Link className="font-medium" href={documentHref(scope, hit.citation)}>
              {hit.title ?? hit.citation.documentId}
            </Link>
            <Text>{names.get(hit.citation.brainId) ?? hit.citation.brainId}</Text>
            <Badge color="zinc">{hit.sensitivity}</Badge>
            <Text className="ml-auto">Score {hit.score.toFixed(3)}</Text>
          </div>
          <Text className="whitespace-pre-wrap">{hit.excerpt}</Text>
        </li>
      ))}
    </ol>
  );
}

function Answer({
  answer,
  names,
  scope,
}: Readonly<{ answer: BrainAnswer; names: Names; scope: EnvironmentScope }>) {
  const claims = joinClaims(answer);
  return (
    <div className="flex flex-col gap-6">
      {claims.length === 0 ? (
        <Text>No cited answer.</Text>
      ) : (
        <ul className="flex flex-col gap-3">
          {claims.map((claim, index) => (
            <li className="flex flex-col gap-1" key={index}>
              <Text>
                {claim.text}{" "}
                {claim.citations.map(({ citation, number }) => (
                  <Link
                    className="text-xs align-super"
                    href={documentHref(scope, citation)}
                    key={number}
                  >
                    [{number}]
                  </Link>
                ))}
              </Text>
              {claim.unresolved.length === 0 ? null : (
                <Text className="text-warning-foreground">
                  Also cites evidence the answer did not return:{" "}
                  {claim.unresolved.map((id) => (
                    <Code className="mr-1" key={id}>
                      {id}
                    </Code>
                  ))}
                </Text>
              )}
            </li>
          ))}
        </ul>
      )}
      {answer.gaps.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          <Subheading level={3}>Not covered by the evidence</Subheading>
          <ul className="list-disc pl-5">
            {answer.gaps.map((gap, index) => (
              <li key={index}>
                <Text>{gap}</Text>
              </li>
            ))}
          </ul>
        </div>
      )}
      {answer.usedCitations.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          <Subheading level={3}>Sources</Subheading>
          <ol className="flex flex-col gap-1">
            {answer.usedCitations.map((citation, index) => (
              <li className="flex flex-wrap items-center gap-2" key={citationKey(citation)}>
                <Text>[{index + 1}]</Text>
                <Link href={documentHref(scope, citation)}>Document {citation.documentId}</Link>
                <Text>{names.get(citation.brainId) ?? citation.brainId}</Text>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function Feedback({
  queryAttemptId,
  scope,
}: Readonly<{ queryAttemptId: string; scope: EnvironmentScope }>) {
  const [open, setOpen] = useState(false);
  const [opens, setOpens] = useState(0);
  const [recorded, setRecorded] = useState<BrainFeedback | undefined>(undefined);
  return (
    <div className="ml-auto flex items-center gap-3">
      {recorded ? <Badge color="zinc">Rated {recorded.usefulness}</Badge> : null}
      <Button
        onClick={() => {
          setOpens(opens + 1);
          setOpen(true);
        }}
        variant="outline"
      >
        {recorded ? "Change rating" : "Rate this result"}
      </Button>
      <FeedbackDialog
        key={opens}
        onClose={() => setOpen(false)}
        onRecorded={setRecorded}
        open={open}
        queryAttemptId={queryAttemptId}
        scope={scope}
      />
    </div>
  );
}

function FeedbackDialog({
  onClose,
  onRecorded,
  open,
  queryAttemptId,
  scope,
}: Readonly<{
  onClose: () => void;
  onRecorded: (feedback: BrainFeedback) => void;
  open: boolean;
  queryAttemptId: string;
  scope: EnvironmentScope;
}>) {
  const [usefulness, setUsefulness] = useState<Usefulness>("useful");
  const [note, setNote] = useState("");
  const held = useKeyedSnapshot<FeedbackBody>();
  const body: FeedbackBody =
    note.trim() === "" ? { usefulness } : { feedback: note.trim(), usefulness };
  return (
    <ActionDialog
      confirmLabel="Record rating"
      description="The rating covers this whole query and replaces any earlier usefulness. An earlier note stays unless you write a new one. Anyone in the organization who can read Brains can replace the rating."
      onClose={onClose}
      onSuccess={onRecorded}
      open={open}
      retryNotice="The rating may have been recorded. Submitting again sends the same rating, which replaces itself if it was."
      run={(idempotencyKey, resend) =>
        recordBrainFeedbackFn({
          data: {
            body: held(idempotencyKey, resend, body),
            idempotencyKey,
            queryAttemptId,
            scope: { organizationId: scope.organizationId },
          },
        })
      }
      successMessage="Rating recorded"
      title="Rate this result"
    >
      <Fieldset>
        <Legend>Usefulness</Legend>
        <RadioGroup
          onValueChange={(value: string) => {
            const next = oneOf(USEFULNESS, value);
            if (next) setUsefulness(next);
          }}
          value={usefulness}
        >
          {USEFULNESS.map((value) => (
            <RadioField key={value}>
              <RadioGroupItem value={value} />
              <Label className="capitalize">{value}</Label>
            </RadioField>
          ))}
        </RadioGroup>
      </Fieldset>
      <Field>
        <Label>Note</Label>
        <Description>Optional. What was right or wrong about the result.</Description>
        <Textarea
          maxLength={MAX_FEEDBACK_LENGTH}
          onChange={(event) => setNote(event.target.value)}
          rows={3}
          value={note}
        />
      </Field>
    </ActionDialog>
  );
}
