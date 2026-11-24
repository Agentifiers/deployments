import { CommentAdd01Icon, StarIcon } from "@hugeicons/core-free-icons";
import type { AnnotationResponse, ScoreResultResponse } from "@deployments-ai/api-contract";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { environmentQuery, organizationShellQuery } from "../../data/console-queries.ts";
import {
  createTraceAnnotationFn,
  invalidateTraceFeedback,
  recordTraceScoreFn,
  scoreDefinitionDirectoryQuery,
  traceAnnotationsQuery,
  traceScoresQuery,
} from "../../data/trace-feedback-queries.ts";
import type { SpanSummary } from "../../observability/traces.ts";
import type { EnvironmentScope } from "../../scope.ts";
import type { ScoreDefinitionEntry } from "../../server/trace-feedback-data.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CheckboxField, Description, Field, Label } from "@/components/ui/field";
import { Subheading } from "@/components/ui/heading";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "@/components/reui/number-field";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { Code, Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";
import { Icon } from "../icon.tsx";
import { PublicId } from "../public-id.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { Timestamp } from "./panels.tsx";

/** Contract limits: `CreateAnnotationRequest` and `RecordScoreResultRequest`. */
const MAX_BODY_LENGTH = 4_000;
const MAX_LABEL_LENGTH = 64;
const MAX_RATIONALE_LENGTH = 2_000;
const SPAN_ID = /^[a-f0-9]{16}$/u;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

/** The selected span as the evaluation routes accept it: a W3C span ID and the run it belongs to. */
function spanLink(span: SpanSummary | undefined) {
  if (!span) return {};
  return {
    ...(SPAN_ID.test(span.span_id) ? { spanId: span.span_id } : {}),
    ...(span.run_id && ULID.test(span.run_id) ? { runId: span.run_id } : {}),
  };
}

function Linkage({ runId, spanId }: Readonly<{ runId?: string; spanId?: string }>) {
  if (!runId && !spanId) return <>Trace</>;
  return (
    <span className="flex flex-col">
      {spanId ? (
        <span className="flex items-center gap-1">
          Span <PublicId value={spanId} />
        </span>
      ) : null}
      {runId ? (
        <span className="flex items-center gap-1">
          Run <PublicId value={runId} />
        </span>
      ) : null}
    </span>
  );
}

function SpanLinkField({
  checked,
  onChange,
  span,
}: Readonly<{ checked: boolean; onChange: (checked: boolean) => void; span: SpanSummary }>) {
  return (
    <CheckboxField>
      <Checkbox checked={checked} onCheckedChange={onChange} />
      <Label>Link to the selected span</Label>
      <Description>
        {span.name || span.kind || "Span"} <Code>{span.span_id}</Code>
        {span.run_id ? (
          <>
            {" "}
            in run <Code>{span.run_id}</Code>
          </>
        ) : null}
      </Description>
    </CheckboxField>
  );
}

function AnnotateDialog({
  onClose,
  open,
  scope,
  span,
  traceId,
}: Readonly<{
  onClose: () => void;
  open: boolean;
  scope: EnvironmentScope;
  span: SpanSummary | undefined;
  traceId: string;
}>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [body, setBody] = useState("");
  const [label, setLabel] = useState("");
  const [linkSpan, setLinkSpan] = useState(true);
  useEffect(() => {
    if (!open) return;
    setBody("");
    setLabel("");
    setLinkSpan(true);
  }, [open]);
  const trimmedBody = body.trim();
  const trimmedLabel = label.trim();
  return (
    <ActionDialog
      confirmLabel="Annotate"
      confirmation={typedConfirmation(environment.type, { phrase: "annotate" })}
      description="A reviewer note on this trace, optionally tied to the selected span."
      invalid={trimmedBody.length === 0 || trimmedBody.length > MAX_BODY_LENGTH}
      onClose={onClose}
      onSuccess={() => void invalidateTraceFeedback(queryClient, scope, traceId)}
      open={open}
      run={(idempotencyKey) =>
        createTraceAnnotationFn({
          data: {
            body: {
              body: trimmedBody,
              ...(trimmedLabel ? { label: trimmedLabel } : {}),
              ...(linkSpan ? spanLink(span) : {}),
            },
            idempotencyKey,
            scope,
            traceId,
          },
        })
      }
      successMessage="Annotation added"
      title="Annotate trace"
    >
      <Field>
        <Label>Note</Label>
        <Textarea
          maxLength={MAX_BODY_LENGTH}
          onChange={(event) => setBody(event.target.value)}
          rows={4}
          value={body}
        />
      </Field>
      <Field>
        <Label>Label</Label>
        <Description>Optional, for grouping (for example “hallucination”).</Description>
        <Input
          maxLength={MAX_LABEL_LENGTH}
          onChange={(event) => setLabel(event.target.value)}
          value={label}
        />
      </Field>
      {span ? <SpanLinkField checked={linkSpan} onChange={setLinkSpan} span={span} /> : null}
    </ActionDialog>
  );
}

function ScoreDialog({
  onClose,
  open,
  scope,
  span,
  traceId,
}: Readonly<{
  onClose: () => void;
  open: boolean;
  scope: EnvironmentScope;
  span: SpanSummary | undefined;
  traceId: string;
}>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const definitions = useQuery({ ...scoreDefinitionDirectoryQuery(scope), enabled: open });
  const recordable = (definitions.data ?? []).filter((definition) => definition.recordable);
  const [definitionId, setDefinitionId] = useState("");
  const [value, setValue] = useState("");
  const [label, setLabel] = useState("");
  const [rationale, setRationale] = useState("");
  const [linkSpan, setLinkSpan] = useState(true);
  useEffect(() => {
    if (!open) return;
    setDefinitionId("");
    setValue("");
    setLabel("");
    setRationale("");
    setLinkSpan(true);
  }, [open]);
  const definition = recordable.find((candidate) => candidate.id === definitionId);
  const score = value.trim() === "" ? Number.NaN : Number(value);
  const validScore = Number.isFinite(score) && score >= 0 && score <= 1;
  const trimmedLabel = label.trim();
  const trimmedRationale = rationale.trim();
  return (
    <ActionDialog
      confirmLabel="Record score"
      confirmation={typedConfirmation(environment.type, { phrase: "score" })}
      description="Record a human or imported score for this trace against an active score definition."
      invalid={!definition || !validScore || trimmedRationale.length > MAX_RATIONALE_LENGTH}
      onClose={onClose}
      onSuccess={() => void invalidateTraceFeedback(queryClient, scope, traceId)}
      open={open}
      run={(idempotencyKey) =>
        recordTraceScoreFn({
          data: {
            body: {
              scoreDefinitionId: definitionId,
              value: score,
              ...(trimmedLabel ? { label: trimmedLabel } : {}),
              ...(trimmedRationale ? { rationale: trimmedRationale } : {}),
              ...(linkSpan ? spanLink(span) : {}),
            },
            idempotencyKey,
            scope,
            traceId,
          },
        })
      }
      successMessage="Score recorded"
      title="Score trace"
    >
      {definitions.isPending ? (
        <Text>Loading score definitions…</Text>
      ) : definitions.error ? (
        <Text>Score definitions could not be loaded: {definitions.error.message}</Text>
      ) : recordable.length === 0 ? (
        <Text>
          No active human or imported score definitions exist. Create one under Evaluations, then
          score this trace.
        </Text>
      ) : (
        <>
          <Field>
            <Label>Score definition</Label>
            {definition?.description ? <Description>{definition.description}</Description> : null}
            <NativeSelect
              onChange={(event) => {
                setDefinitionId(event.target.value);
                setLabel("");
              }}
              value={definitionId}
            >
              <option disabled value="">
                Choose a score definition
              </option>
              {recordable.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name} ({candidate.evaluatorKind})
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <Label>Value</Label>
            <Description>
              Between 0 and 1.
              {definition ? ` Passes at ${definition.threshold} or above.` : ""}
            </Description>
            <NumberField
              allowOutOfRange
              format={{ maximumFractionDigits: 20 }}
              max={1}
              min={0}
              onValueChange={(next) => setValue(next === null ? "" : String(next))}
              step="any"
              value={Number.isFinite(score) ? score : null}
            >
              <NumberFieldGroup>
                <NumberFieldInput
                  className="text-start"
                  onChange={(event) => setValue(event.currentTarget.value)}
                />
              </NumberFieldGroup>
            </NumberField>
          </Field>
          <ScoreLabelField definition={definition} onChange={setLabel} value={label} />
          <Field>
            <Label>Rationale</Label>
            <Textarea
              maxLength={MAX_RATIONALE_LENGTH}
              onChange={(event) => setRationale(event.target.value)}
              rows={3}
              value={rationale}
            />
          </Field>
          {span ? <SpanLinkField checked={linkSpan} onChange={setLinkSpan} span={span} /> : null}
        </>
      )}
    </ActionDialog>
  );
}

/** A human definition with labels accepts only those; otherwise the label is free text. */
function ScoreLabelField({
  definition,
  onChange,
  value,
}: Readonly<{
  definition: ScoreDefinitionEntry | undefined;
  onChange: (value: string) => void;
  value: string;
}>) {
  return (
    <Field>
      <Label>Label</Label>
      {definition?.labels ? (
        <NativeSelect onChange={(event) => onChange(event.target.value)} value={value}>
          <option value="">No label</option>
          {definition.labels.map((label) => (
            <option key={label} value={label}>
              {label}
            </option>
          ))}
        </NativeSelect>
      ) : (
        <Input
          maxLength={MAX_LABEL_LENGTH}
          onChange={(event) => onChange(event.target.value)}
          value={value}
        />
      )}
    </Field>
  );
}

function ScoreOutcome({ score }: Readonly<{ score: ScoreResultResponse }>) {
  if (score.executionStatus === "error") {
    return (
      <Badge color="red" title={score.errorMessage}>
        {score.errorClass ?? "error"}
      </Badge>
    );
  }
  if (score.passed === undefined) return <>—</>;
  return <Badge color={score.passed ? "green" : "red"}>{score.passed ? "passed" : "failed"}</Badge>;
}

function ScoreList({
  canNameDefinitions,
  scope,
  traceId,
}: Readonly<{ canNameDefinitions: boolean; scope: EnvironmentScope; traceId: string }>) {
  const { data } = useSuspenseQuery(traceScoresQuery(scope, traceId));
  // Names are a nicety: without them (no access, or still loading) rows show the definition ID.
  const definitions = useQuery({
    ...scoreDefinitionDirectoryQuery(scope),
    enabled: canNameDefinitions && data.items.length > 0,
  });
  const names = new Map(definitions.data?.map((definition) => [definition.id, definition.name]));
  if (data.items.length === 0) {
    return <Text>No scores yet. Score this trace to record one.</Text>;
  }
  return (
    <>
      <Table dense striped>
        <TableHeader>
          <TableRow>
            <TableHead>Score</TableHead>
            <TableHead className="text-right">Value</TableHead>
            <TableHead>Result</TableHead>
            <TableHead>Label</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Linked to</TableHead>
            <TableHead>Recorded</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.items.map((score) => (
            <TableRow key={score.id}>
              <TableCell className="max-w-72">
                <div className="flex flex-col">
                  <span className="truncate">
                    {names.get(score.scoreDefinitionId) ?? (
                      <PublicId value={score.scoreDefinitionId} />
                    )}{" "}
                    <span className="text-muted-foreground">r{score.revision}</span>
                  </span>
                  {score.rationale ? (
                    <span className="text-xs/5 whitespace-normal text-muted-foreground">
                      {score.rationale}
                    </span>
                  ) : null}
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {score.value === undefined ? "—" : score.value.toFixed(2)}
                <span className="text-muted-foreground"> / ≥{score.threshold}</span>
              </TableCell>
              <TableCell>
                <ScoreOutcome score={score} />
              </TableCell>
              <TableCell>{score.label ?? "—"}</TableCell>
              <TableCell>
                <span className="flex flex-col">
                  {score.source}
                  {score.humanActorPrincipalId ? (
                    <PublicId value={score.humanActorPrincipalId} />
                  ) : null}
                </span>
              </TableCell>
              <TableCell>
                <Linkage
                  {...(score.runId ? { runId: score.runId } : {})}
                  {...(score.spanId ? { spanId: score.spanId } : {})}
                />
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <Timestamp value={score.createdAt} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {data.truncated ? (
        <Text>Showing the newest {data.items.length} scores of this trace.</Text>
      ) : null}
    </>
  );
}

function AnnotationItem({ annotation }: Readonly<{ annotation: AnnotationResponse }>) {
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm/6 text-muted-foreground">
        {annotation.label ? <Badge color="blue">{annotation.label}</Badge> : null}
        {annotation.tags.map((tag) => (
          <Badge color="zinc" key={tag}>
            {tag}
          </Badge>
        ))}
        <span className="flex items-center gap-1">
          by <PublicId value={annotation.authorPrincipalId} />
        </span>
        <span>·</span>
        <Timestamp value={annotation.createdAt} />
        <span>·</span>
        <Linkage
          {...(annotation.runId ? { runId: annotation.runId } : {})}
          {...(annotation.spanId ? { spanId: annotation.spanId } : {})}
        />
      </div>
      <p className="text-sm/6 whitespace-pre-wrap text-foreground">{annotation.body}</p>
    </li>
  );
}

function AnnotationList({
  scope,
  traceId,
}: Readonly<{ scope: EnvironmentScope; traceId: string }>) {
  const { data } = useSuspenseQuery(traceAnnotationsQuery(scope, traceId));
  if (data.items.length === 0) {
    return <Text>No annotations yet. Annotate this trace to add a note for reviewers.</Text>;
  }
  return (
    <>
      <ul className="divide-y divide-border">
        {data.items.map((annotation) => (
          <AnnotationItem annotation={annotation} key={annotation.id} />
        ))}
      </ul>
      {data.truncated ? (
        <Text>Showing the newest {data.items.length} annotations of this trace.</Text>
      ) : null}
    </>
  );
}

/**
 * Trace detail footer (plan §6.3): the trace's scores and annotations with Annotate and Score
 * actions. New feedback links to the span selected in the waterfall unless the user unlinks it.
 */
export function TraceFeedback({
  scope,
  selectedSpan,
  traceId,
}: Readonly<{ scope: EnvironmentScope; selectedSpan: SpanSummary | undefined; traceId: string }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { access } = shell;
  const [dialog, setDialog] = useState<"annotate" | "score" | undefined>();
  const canScore = access.recordTraceScoreResult && access.listScoreDefinitions;
  if (!access.listTraceScoreResults && !access.listTraceAnnotations && !canScore) return null;
  const close = () => setDialog(undefined);
  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Subheading>Scores and annotations</Subheading>
        <div className="ml-auto flex gap-2">
          {access.createTraceAnnotation ? (
            <Button onClick={() => setDialog("annotate")} variant="outline">
              <Icon icon={CommentAdd01Icon} />
              Annotate
            </Button>
          ) : null}
          {canScore ? (
            <Button onClick={() => setDialog("score")} variant="outline">
              <Icon icon={StarIcon} />
              Score
            </Button>
          ) : null}
        </div>
      </div>
      {access.listTraceScoreResults ? (
        <div className="flex flex-col gap-3">
          <h4 className="text-sm/6 font-medium text-muted-foreground">Scores</h4>
          <SectionBoundary resetKey={`${traceId}-scores`}>
            <ScoreList
              canNameDefinitions={access.listScoreDefinitions}
              scope={scope}
              traceId={traceId}
            />
          </SectionBoundary>
        </div>
      ) : null}
      {access.listTraceAnnotations ? (
        <div className="flex flex-col gap-3">
          <h4 className="text-sm/6 font-medium text-muted-foreground">Annotations</h4>
          <SectionBoundary resetKey={`${traceId}-annotations`}>
            <AnnotationList scope={scope} traceId={traceId} />
          </SectionBoundary>
        </div>
      ) : null}
      {access.createTraceAnnotation ? (
        <AnnotateDialog
          onClose={close}
          open={dialog === "annotate"}
          scope={scope}
          span={selectedSpan}
          traceId={traceId}
        />
      ) : null}
      {canScore ? (
        <ScoreDialog
          onClose={close}
          open={dialog === "score"}
          scope={scope}
          span={selectedSpan}
          traceId={traceId}
        />
      ) : null}
    </section>
  );
}
