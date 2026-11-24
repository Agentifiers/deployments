import {
  STANDING_HOLD_REASONS,
  STANDING_NAME_PATTERN_SOURCE,
} from "@deployments-ai/api-contract/system";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { placeHoldFn, releaseHoldFn } from "../../data/system-mutations.ts";
import { invalidateStanding } from "../../data/system-queries.ts";
import { oneOf } from "../../observability/range.ts";
import type { SystemStanding } from "../../server/system-data.ts";
import { Description, ErrorMessage, Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { ActionDialog } from "../action-dialog.tsx";

export type HoldReason = (typeof STANDING_HOLD_REASONS)[number];
export type StandingHold = SystemStanding["holds"][number];

const HOLD_KEY = new RegExp(STANDING_NAME_PATTERN_SOURCE, "u");
const MAX_TEXT = 500;

export const REASON_COPY: Readonly<Record<HoldReason, string>> = {
  abuse: "Abuse. Running work stops.",
  manual: "Manual. Running work stops.",
  payment: "Payment. Admitted runs finish; nothing new starts.",
  policy: "Policy. Running work stops.",
};

/** A required standing text: non-blank and at most 500 characters. */
export function textProblem(text: string, required: boolean): string | undefined {
  if (text.trim() === "") return required ? "Required" : undefined;
  return text.length > MAX_TEXT ? `At most ${MAX_TEXT} characters` : undefined;
}

export interface HoldDraft {
  readonly customerMessage: string;
  readonly key: string;
  readonly operatorNote: string;
  readonly reason: HoldReason;
}

export function holdProblems(draft: HoldDraft) {
  return {
    customerMessage: textProblem(draft.customerMessage, true),
    key: HOLD_KEY.test(draft.key)
      ? undefined
      : "1 to 63 lowercase letters, digits, or hyphens, not starting with a hyphen",
    operatorNote: textProblem(draft.operatorNote, false),
  };
}

const optionalText = (text: string) => (text.trim() === "" ? undefined : text.trim());

export function PlaceHoldDialog({
  confirmation,
  existingKeys,
  onClose,
  organizationId,
}: Readonly<{
  confirmation: string;
  existingKeys: readonly string[];
  onClose: () => void;
  organizationId: string;
}>) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<HoldDraft>({
    customerMessage: "",
    key: "",
    operatorNote: "",
    reason: "manual",
  });
  const problems = holdProblems(draft);
  const replaces = existingKeys.includes(draft.key);
  const operatorNote = optionalText(draft.operatorNote);
  return (
    <ActionDialog
      confirmLabel="Place hold"
      confirmation={confirmation}
      description="A hold suspends the organization: its members see the customer message and can change nothing until every hold is released."
      destructive
      invalid={Object.values(problems).some((problem) => problem !== undefined)}
      onClose={onClose}
      onSuccess={() => void invalidateStanding(queryClient, organizationId)}
      open
      runOnce={() =>
        placeHoldFn({
          data: {
            body: {
              customerMessage: draft.customerMessage.trim(),
              reason: draft.reason,
              ...(operatorNote === undefined ? {} : { operatorNote }),
            },
            holdKey: draft.key,
            organizationId,
          },
        })
      }
      size="xl"
      successMessage={(result) =>
        result.changed ? "Hold placed" : { neutral: "That hold was already in place" }
      }
      title="Place a hold"
    >
      <Field>
        <Label>Reason</Label>
        <NativeSelect
          name="reason"
          onChange={(event) => {
            const reason = oneOf(STANDING_HOLD_REASONS, event.target.value);
            if (reason) setDraft({ ...draft, reason });
          }}
          value={draft.reason}
        >
          {STANDING_HOLD_REASONS.map((reason) => (
            <option key={reason} value={reason}>
              {REASON_COPY[reason]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field>
        <Label>Hold key</Label>
        <Input
          autoComplete="off"
          name="key"
          onChange={(event) => setDraft({ ...draft, key: event.target.value })}
          placeholder="manual-review"
          value={draft.key}
        />
        {draft.key !== "" && problems.key ? <ErrorMessage>{problems.key}</ErrorMessage> : null}
        {replaces ? (
          <Description>An operator hold with this key exists; placing it replaces it.</Description>
        ) : (
          <Description>Your name for the hold, used to release it later.</Description>
        )}
      </Field>
      <Field>
        <Label>Customer message</Label>
        <Textarea
          name="customerMessage"
          onChange={(event) => setDraft({ ...draft, customerMessage: event.target.value })}
          rows={3}
          value={draft.customerMessage}
        />
        <Description>Shown to the organization's members while the hold lasts.</Description>
        {draft.customerMessage !== "" && problems.customerMessage ? (
          <ErrorMessage>{problems.customerMessage}</ErrorMessage>
        ) : null}
      </Field>
      <Field>
        <Label>Operator note (optional)</Label>
        <Textarea
          name="operatorNote"
          onChange={(event) => setDraft({ ...draft, operatorNote: event.target.value })}
          rows={2}
          value={draft.operatorNote}
        />
        <Description>Seen only by operators and services, never by members.</Description>
        {problems.operatorNote ? <ErrorMessage>{problems.operatorNote}</ErrorMessage> : null}
      </Field>
    </ActionDialog>
  );
}

export function ReleaseHoldDialog({
  hold,
  onClose,
  organizationId,
}: Readonly<{ hold: StandingHold; onClose: () => void; organizationId: string }>) {
  const queryClient = useQueryClient();
  const [releaseNote, setReleaseNote] = useState("");
  const problem = textProblem(releaseNote, false);
  const note = optionalText(releaseNote);
  return (
    <ActionDialog
      confirmLabel="Release hold"
      description={`The organization stays suspended while any other hold remains. Members saw: "${hold.customerMessage}"`}
      invalid={problem !== undefined}
      onClose={onClose}
      onSuccess={() => void invalidateStanding(queryClient, organizationId)}
      open
      runOnce={() =>
        releaseHoldFn({
          data: {
            body: note === undefined ? {} : { releaseNote: note },
            holdKey: hold.key,
            organizationId,
          },
        })
      }
      successMessage={(result) =>
        result.changed ? "Hold released" : { neutral: "That hold was already released" }
      }
      title={`Release the ${hold.key} hold`}
    >
      <Field>
        <Label>Release note (optional)</Label>
        <Textarea
          name="releaseNote"
          onChange={(event) => setReleaseNote(event.target.value)}
          rows={2}
          value={releaseNote}
        />
        <Description>Recorded in the standing history.</Description>
        {problem ? <ErrorMessage>{problem}</ErrorMessage> : null}
      </Field>
    </ActionDialog>
  );
}
