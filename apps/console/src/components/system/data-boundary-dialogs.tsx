import { DATA_BOUNDARY_PROFILES } from "@deployments-ai/api-contract/system";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { clearDataBoundaryFn, setDataBoundaryFn } from "../../data/system-mutations.ts";
import { invalidateStanding } from "../../data/system-queries.ts";
import { oneOf } from "../../observability/range.ts";
import { Description, ErrorMessage, Field, Label } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { ActionDialog } from "../action-dialog.tsx";
import { textProblem } from "./hold-dialogs.tsx";

type DataBoundaryProfile = (typeof DATA_BOUNDARY_PROFILES)[number];

const PROFILE_COPY: Readonly<Record<DataBoundaryProfile, string>> = {
  phi: "PHI. Tools stay off the public internet and models stay on Bedrock.",
};

function OperatorNoteField({
  description,
  note,
  setNote,
}: Readonly<{ description: string; note: string; setNote: (note: string) => void }>) {
  const problem = textProblem(note, true);
  return (
    <Field>
      <Label>Operator note</Label>
      <Textarea
        name="operatorNote"
        onChange={(event) => setNote(event.target.value)}
        rows={2}
        value={note}
      />
      <Description>{description}</Description>
      {note !== "" && problem ? <ErrorMessage>{problem}</ErrorMessage> : null}
    </Field>
  );
}

export function SetDataBoundaryDialog({
  onClose,
  organizationId,
}: Readonly<{ onClose: () => void; organizationId: string }>) {
  const queryClient = useQueryClient();
  const [profile, setProfile] = useState<DataBoundaryProfile>("phi");
  const [note, setNote] = useState("");
  return (
    <ActionDialog
      confirmLabel="Set boundary"
      description="Members see that the boundary is in place. Releases that declare a public-internet tool or a model outside Bedrock are refused, and runs fail at the first such call."
      invalid={textProblem(note, true) !== undefined}
      onClose={onClose}
      onSuccess={() => void invalidateStanding(queryClient, organizationId)}
      open
      runOnce={() =>
        setDataBoundaryFn({
          data: { body: { operatorNote: note.trim(), profile }, organizationId },
        })
      }
      successMessage={(result) =>
        result.changed ? "Data boundary set" : { neutral: "That boundary was already in place" }
      }
      title="Set a data boundary"
    >
      <Field>
        <Label>Profile</Label>
        <NativeSelect
          name="profile"
          onChange={(event) => {
            const next = oneOf(DATA_BOUNDARY_PROFILES, event.target.value);
            if (next) setProfile(next);
          }}
          value={profile}
        >
          {DATA_BOUNDARY_PROFILES.map((option) => (
            <option key={option} value={option}>
              {PROFILE_COPY[option]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <OperatorNoteField
        description="Why, such as the agreement reference. Seen only by operators, never by members."
        note={note}
        setNote={setNote}
      />
    </ActionDialog>
  );
}

export function ClearDataBoundaryDialog({
  confirmation,
  onClose,
  organizationId,
  profile,
}: Readonly<{
  confirmation: string;
  onClose: () => void;
  organizationId: string;
  profile: DataBoundaryProfile;
}>) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  return (
    <ActionDialog
      confirmLabel="Clear boundary"
      confirmation={confirmation}
      description={`Clearing the ${profile} boundary lets the organization's tools reach the public internet and its models run outside Bedrock again.`}
      destructive
      invalid={textProblem(note, true) !== undefined}
      onClose={onClose}
      onSuccess={() => void invalidateStanding(queryClient, organizationId)}
      open
      runOnce={() =>
        clearDataBoundaryFn({ data: { body: { operatorNote: note.trim() }, organizationId } })
      }
      successMessage={(result) =>
        result.changed ? "Data boundary cleared" : { neutral: "There was no boundary to clear" }
      }
      title="Clear the data boundary"
    >
      <OperatorNoteField
        description="Why the boundary ends. Recorded in the standing history."
        note={note}
        setNote={setNote}
      />
    </ActionDialog>
  );
}
