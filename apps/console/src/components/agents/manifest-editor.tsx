import { useState } from "react";
import {
  draftText,
  isJsonObject,
  issuesUnder,
  pathLabel,
  type DraftCheck,
  type ManifestIssue,
} from "../../agents/manifest-draft.ts";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Field, Label } from "@/components/ui/field";
import { Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { SingleToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { instructionsMissing, ManifestForm } from "./manifest-form.tsx";

const VIEWS = { form: "Form", json: "JSON" } as const;
type View = keyof typeof VIEWS;

function isView(value: string): value is View {
  return Object.hasOwn(VIEWS, value);
}

/**
 * Problems to report as errors. Empty instructions are left to the form, which asks for them, so
 * a new draft does not open with an error.
 */
function reportedIssues(issues: readonly ManifestIssue[], value: unknown) {
  if (!instructionsMissing(value)) return issues;
  const missing = new Set(issuesUnder(issues, ["spec", "instructions"]));
  return issues.filter((issue) => !missing.has(issue));
}

/** Every problem that blocks saving, each with the manifest path it concerns. */
function CheckProblems({ check }: Readonly<{ check: DraftCheck }>) {
  if (check.kind === "valid") return null;
  const issues = check.kind === "invalid" ? reportedIssues(check.issues, check.value) : [];
  if (check.kind === "invalid" && issues.length === 0) return null;
  return (
    <Callout variant="destructive">
      <CalloutTitle>
        {check.kind === "syntax"
          ? "The manifest is not valid JSON"
          : `The manifest has ${issues.length} ${issues.length === 1 ? "problem" : "problems"}`}
      </CalloutTitle>
      <CalloutDescription>
        {check.kind === "syntax" ? (
          <p>{check.message}</p>
        ) : (
          <ul aria-label="Manifest problems" className="list-disc pl-5">
            {issues.map((issue) => (
              <li key={`${pathLabel(issue.path)} ${issue.message}`}>
                <code className="font-mono">{pathLabel(issue.path)}</code>: {issue.message}
              </li>
            ))}
          </ul>
        )}
      </CalloutDescription>
    </Callout>
  );
}

/**
 * Two views over one manifest draft held as JSON text: a form for the common fields and the
 * whole document as JSON. Both write the same text, and `check` (from `checkDraft`) says whether
 * it can be saved; its problems show inline in the form and as a list above both views.
 */
export function ManifestEditor({
  check,
  layout,
  onText,
  text,
}: Readonly<{
  check: DraftCheck;
  /** `create` puts a new agent's name and instructions first; see `ManifestForm`. */
  layout?: "create" | "full" | undefined;
  onText: (text: string) => void;
  text: string;
}>) {
  const [view, setView] = useState<View>("form");
  const value = check.kind === "syntax" ? undefined : check.value;
  const issues = check.kind === "invalid" ? check.issues : [];
  return (
    <div className="flex flex-col gap-4">
      <SingleToggleGroup
        aria-label="Editor view"
        className="self-start"
        onValueChange={(next) => {
          if (isView(next)) setView(next);
        }}
        size="sm"
        value={view}
      >
        {Object.entries(VIEWS).map(([key, label]) => (
          <ToggleGroupItem key={key} value={key}>
            {label}
          </ToggleGroupItem>
        ))}
      </SingleToggleGroup>
      <CheckProblems check={check} />
      {view === "json" ? (
        <Field>
          <Label>Manifest JSON</Label>
          <Textarea
            aria-invalid={check.kind !== "valid" || undefined}
            className="font-mono text-xs/5"
            name="manifest"
            onChange={(event) => onText(event.target.value)}
            rows={28}
            spellCheck={false}
            value={text}
          />
        </Field>
      ) : isJsonObject(value) ? (
        <ManifestForm
          issues={issues}
          layout={layout}
          onChange={(next) => onText(draftText(next))}
          value={value}
        />
      ) : (
        <Text>Fix the JSON in the JSON view to edit the manifest with the form.</Text>
      )}
    </div>
  );
}
