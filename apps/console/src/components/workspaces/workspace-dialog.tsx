import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { environmentQuery } from "../../data/console-queries.ts";
import { createWorkspaceFn } from "../../data/connection-mutations.ts";
import { invalidateConnections } from "../../data/connection-queries.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Description, Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 2_000;

export function CreateWorkspaceDialog({
  onClose,
  open,
  scope,
}: Readonly<{ onClose: () => void; open: boolean; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  useEffect(() => {
    if (!open) return;
    setName("");
    setSlug("");
    setDescription("");
  }, [open]);
  const trimmedName = name.trim();
  const trimmedSlug = slug.trim();
  const trimmedDescription = description.trim();
  const nameValid = trimmedName.length > 0 && trimmedName.length <= MAX_NAME_LENGTH;
  const slugValid = trimmedSlug === "" || SLUG.test(trimmedSlug);
  const descriptionValid = trimmedDescription.length <= MAX_DESCRIPTION_LENGTH;

  return (
    <ActionDialog
      confirmLabel="Create workspace"
      confirmation={typedConfirmation(environment.type, { phrase: trimmedName || "create" })}
      description="Runs and connection grants name a workspace, so agents use a connection only where it is granted."
      invalid={!nameValid || !slugValid || !descriptionValid}
      onClose={onClose}
      onSuccess={() => void invalidateConnections(queryClient, scope)}
      open={open}
      run={(idempotencyKey) =>
        createWorkspaceFn({
          data: {
            body: {
              name: trimmedName,
              ...(trimmedSlug ? { slug: trimmedSlug } : {}),
              ...(trimmedDescription ? { description: trimmedDescription } : {}),
            },
            idempotencyKey,
            scope,
          },
        })
      }
      successMessage="Workspace created"
      title="Create a workspace"
    >
      <Field>
        <Label>Name</Label>
        <Input
          autoComplete="off"
          aria-invalid={name !== "" && !nameValid}
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
      </Field>
      <Field>
        <Label>Slug (optional)</Label>
        <Description>
          Lowercase letters, digits, and hyphens. The platform derives one from the name when it is
          blank.
        </Description>
        <Input
          autoComplete="off"
          aria-invalid={!slugValid}
          onChange={(event) => setSlug(event.target.value)}
          value={slug}
        />
      </Field>
      <Field>
        <Label>Description (optional)</Label>
        <Textarea
          aria-invalid={!descriptionValid}
          onChange={(event) => setDescription(event.target.value)}
          rows={3}
          value={description}
        />
      </Field>
    </ActionDialog>
  );
}
