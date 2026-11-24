import type { BrainResponse } from "@deployments-ai/api-contract/brains";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  BRAIN_RETRY_NOTICES,
  BRAIN_SENSITIVITIES,
  editBrainBody,
  isBrainSlug,
  KIND_LABELS,
  type BrainSensitivity,
  type BrainView,
  type UpdateBrainBody,
} from "../../brains/model.ts";
import { updateBrainFn } from "../../data/brain-mutations.ts";
import { invalidateBrains } from "../../data/brain-queries.ts";
import { oneOf } from "../../observability/range.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Description, Field, Label } from "@/components/ui/field";
import { Subheading } from "@/components/ui/heading";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Code, Text } from "@/components/ui/text";
import { ActionDialog, refreshOnConflict } from "../action-dialog.tsx";
import { useKeyedSnapshot } from "../keyed-snapshot.ts";
import { Timestamp } from "../observability/panels.tsx";
import { ArchiveBrain } from "./brain-erase.tsx";

export function BrainSettings({
  scope,
  view,
}: Readonly<{ scope: EnvironmentScope; view: BrainView }>) {
  const { brain, standing } = view;
  const [edits, setEdits] = useState(0);
  const [editing, setEditing] = useState(false);
  const owner = standing.kind === "owner";
  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Subheading>Details</Subheading>
          {owner ? (
            <Button
              className="ml-auto"
              onClick={() => {
                setEdits(edits + 1);
                setEditing(true);
              }}
              variant="outline"
            >
              Edit
            </Button>
          ) : null}
        </div>
        {owner ? null : <Text>Only the Brain&apos;s owners can edit these details.</Text>}
        <DescriptionList>
          <DescriptionTerm>Name</DescriptionTerm>
          <DescriptionDetails>{brain.name}</DescriptionDetails>
          <DescriptionTerm>Slug</DescriptionTerm>
          <DescriptionDetails>
            <Code>{brain.slug}</Code>
          </DescriptionDetails>
          <DescriptionTerm>Kind</DescriptionTerm>
          <DescriptionDetails>{KIND_LABELS[brain.kind]}</DescriptionDetails>
          <DescriptionTerm>Sensitivity</DescriptionTerm>
          <DescriptionDetails>{brain.sensitivity}</DescriptionDetails>
          <DescriptionTerm>Created</DescriptionTerm>
          <DescriptionDetails>
            <Timestamp value={brain.createdAt} />
          </DescriptionDetails>
          <DescriptionTerm>Updated</DescriptionTerm>
          <DescriptionDetails>
            <Timestamp value={brain.updatedAt} />
          </DescriptionDetails>
        </DescriptionList>
      </section>
      {owner ? <ArchiveBrain brain={brain} scope={scope} /> : null}
      {owner ? (
        <EditBrainDialog
          brain={brain}
          key={edits}
          onClose={() => setEditing(false)}
          open={editing}
        />
      ) : null}
    </div>
  );
}

function EditBrainDialog({
  brain,
  onClose,
  open,
}: Readonly<{ brain: BrainResponse; onClose: () => void; open: boolean }>) {
  const queryClient = useQueryClient();
  const [base, setBase] = useState(brain);
  const [name, setName] = useState(brain.name);
  const [slug, setSlug] = useState(brain.slug);
  const [sensitivity, setSensitivity] = useState<BrainSensitivity>(brain.sensitivity);
  const held = useKeyedSnapshot<UpdateBrainBody>();
  const refresh = () => invalidateBrains(queryClient, brain.organizationId);
  const body = editBrainBody(base, { name, sensitivity, slug });
  const reload = () => {
    setBase(brain);
    setName(brain.name);
    setSlug(brain.slug);
    setSensitivity(brain.sensitivity);
  };
  return (
    <ActionDialog
      confirmLabel="Save changes"
      invalid={name.trim() === "" || !isBrainSlug(slug) || Object.keys(body).length === 1}
      onClose={onClose}
      onSuccess={() => void refresh()}
      open={open}
      retryNotice={BRAIN_RETRY_NOTICES.edit}
      run={(idempotencyKey, resend) =>
        refreshOnConflict(
          updateBrainFn({
            data: {
              body: held(idempotencyKey, resend, body),
              brainId: brain.id,
              idempotencyKey,
              scope: { organizationId: brain.organizationId },
            },
          }),
          refresh,
        )
      }
      successMessage="Brain updated"
      title={`Edit ${base.name}`}
    >
      {brain.version === base.version ? null : (
        <Callout variant="destructive">
          <CalloutTitle>This Brain changed after you started editing</CalloutTitle>
          <CalloutDescription>
            <p>
              Someone saved it, so saving these changes would fail. Load the latest details to start
              over; your changes here are discarded.
            </p>
            <div className="mt-3">
              <Button onClick={reload} variant="outline" type="button">
                Load the latest details
              </Button>
            </div>
          </CalloutDescription>
        </Callout>
      )}
      <Field>
        <Label>Name</Label>
        <Input autoComplete="off" onChange={(event) => setName(event.target.value)} value={name} />
      </Field>
      <Field invalid={!isBrainSlug(slug)}>
        <Label>Slug</Label>
        <Description>
          Up to 80 lowercase letters, digits, and hyphens. Unique in the organization.
        </Description>
        <Input
          autoComplete="off"
          aria-invalid={!isBrainSlug(slug)}
          onChange={(event) => setSlug(event.target.value)}
          value={slug}
        />
      </Field>
      <Field>
        <Label>Sensitivity</Label>
        <NativeSelect
          onChange={(event) => {
            const next = oneOf(BRAIN_SENSITIVITIES, event.target.value);
            if (next) setSensitivity(next);
          }}
          value={sensitivity}
        >
          {BRAIN_SENSITIVITIES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </NativeSelect>
      </Field>
    </ActionDialog>
  );
}
