import { Archive02Icon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import {
  archiveTenancyResourceFn,
  updateTenancyResourceFn,
} from "../../data/tenancy-settings-mutations.ts";
import {
  invalidateTenancySettings,
  tenancyResourceQuery,
} from "../../data/tenancy-settings-queries.ts";
import {
  ARCHIVE_EFFECTS,
  checkGeneral,
  generalDraft,
  LEVEL_COPY,
  type ArchivableLevel,
  type GeneralDraft,
  type TenancyRef,
  type TenancyResource,
} from "../../tenancy/settings.ts";
import { Button } from "@/components/ui/button";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Description, Field, Label } from "@/components/ui/field";
import { Heading, Subheading } from "@/components/ui/heading";
import { Input } from "@/components/ui/input";
import { Code, Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { ActionDialog, refreshOnConflict } from "../action-dialog.tsx";
import { Icon } from "../icon.tsx";
import { useKeyedSnapshot } from "../keyed-snapshot.ts";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { StatusBadge } from "@/components/status-badge";

type ArchivableRef = Extract<TenancyRef, { readonly level: ArchivableLevel }>;

/**
 * One tenancy resource's settings: a General section that renames it, then a Danger zone.
 * `canEdit` and `canArchive` come from the caller's operation access; `danger` replaces the
 * archive action for levels the API cannot archive.
 */
export function SettingsPage({
  canArchive,
  canEdit,
  danger,
  details,
  onArchived,
  reference,
}: Readonly<{
  canArchive: boolean;
  canEdit: boolean;
  danger?: ReactNode;
  /** Extra rows under the General section's facts, such as an environment's type. */
  details?: ReactNode;
  onArchived?: () => void;
  reference: TenancyRef;
}>) {
  const { data: resource } = useSuspenseQuery(tenancyResourceQuery(reference));
  const [dialog, setDialog] = useState<"archive" | "edit">();
  const copy = LEVEL_COPY[reference.level];
  const active = resource.status === "active";
  const archivable = reference.level === "organization" ? undefined : reference;
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>{resource.name} settings</Heading>
        <StatusBadge status={resource.status} />
      </div>

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Subheading>General</Subheading>
          {canEdit ? (
            <Button className="ml-auto" onClick={() => setDialog("edit")} variant="outline">
              <Icon icon={PencilEdit02Icon} />
              Edit
            </Button>
          ) : null}
        </div>
        {canEdit ? null : (
          <Text>Your role or token scopes do not permit changing this {copy.noun}.</Text>
        )}
        <DescriptionList>
          <DescriptionTerm>Name</DescriptionTerm>
          <DescriptionDetails>{resource.name}</DescriptionDetails>
          <DescriptionTerm>Slug</DescriptionTerm>
          <DescriptionDetails>
            <Code>{resource.slug}</Code>
          </DescriptionDetails>
          {copy.describes ? (
            <>
              <DescriptionTerm>Description</DescriptionTerm>
              <DescriptionDetails>{resource.description ?? "—"}</DescriptionDetails>
            </>
          ) : null}
          {details}
          <DescriptionTerm>ID</DescriptionTerm>
          <DescriptionDetails>
            <PublicId value={resource.id} />
          </DescriptionDetails>
          <DescriptionTerm>Version</DescriptionTerm>
          <DescriptionDetails>{resource.version}</DescriptionDetails>
          <DescriptionTerm>Created</DescriptionTerm>
          <DescriptionDetails>
            <Timestamp value={resource.createdAt} />
          </DescriptionDetails>
          <DescriptionTerm>Updated</DescriptionTerm>
          <DescriptionDetails>
            <Timestamp value={resource.updatedAt} />
          </DescriptionDetails>
        </DescriptionList>
      </section>

      <section className="flex flex-col gap-4 rounded-lg border border-destructive/40 p-4">
        <Subheading className="text-destructive">Danger zone</Subheading>
        {danger ??
          (archivable ? (
            <ArchiveSection
              active={active}
              canArchive={canArchive}
              level={archivable.level}
              onArchive={() => setDialog("archive")}
            />
          ) : null)}
      </section>

      {canEdit ? (
        <EditGeneralDialog
          key={`${resource.id}:${dialog === "edit"}`}
          onClose={() => setDialog(undefined)}
          open={dialog === "edit"}
          reference={reference}
          resource={resource}
        />
      ) : null}
      {archivable && canArchive && active ? (
        <ArchiveDialog
          onArchived={onArchived}
          onClose={() => setDialog(undefined)}
          open={dialog === "archive"}
          reference={archivable}
          resource={resource}
        />
      ) : null}
    </div>
  );
}

function ArchiveSection({
  active,
  canArchive,
  level,
  onArchive,
}: Readonly<{
  active: boolean;
  canArchive: boolean;
  level: ArchivableLevel;
  onArchive: () => void;
}>) {
  const { noun } = LEVEL_COPY[level];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1">
          <p className="text-sm/6 font-medium">Archive this {noun}</p>
          <ul className="list-disc pl-5 text-sm/6 text-muted-foreground">
            {ARCHIVE_EFFECTS[level].map((effect) => (
              <li key={effect}>{effect}</li>
            ))}
          </ul>
        </div>
        {active && canArchive ? (
          <Button onClick={onArchive} variant="destructive">
            <Icon icon={Archive02Icon} />
            Archive {noun}
          </Button>
        ) : null}
      </div>
      {active ? null : <Text>This {noun} is archived. Archiving cannot be undone.</Text>}
      {active && !canArchive ? (
        <Text>Your role or token scopes do not permit archiving this {noun}.</Text>
      ) : null}
    </div>
  );
}

function EditGeneralDialog({
  onClose,
  open,
  reference,
  resource,
}: Readonly<{
  onClose: () => void;
  open: boolean;
  reference: TenancyRef;
  resource: TenancyResource;
}>) {
  const queryClient = useQueryClient();
  const [base] = useState(resource);
  const [draft, setDraft] = useState<GeneralDraft>(() => generalDraft(resource));
  const held = useKeyedSnapshot<GeneralDraft>();
  const copy = LEVEL_COPY[reference.level];
  const check = checkGeneral(reference.level, base, draft);
  const invalid = (field: "description" | "name" | "slug") =>
    check.kind === "invalid" && check.field === field;
  const refresh = () => invalidateTenancySettings(queryClient, reference);
  return (
    <ActionDialog
      confirmLabel="Save changes"
      invalid={check.kind !== "changed"}
      onClose={onClose}
      onSuccess={() => void refresh()}
      open={open}
      run={(idempotencyKey, resend) => {
        const sent = checkGeneral(reference.level, base, held(idempotencyKey, resend, draft));
        if (sent.kind !== "changed") throw new Error("Nothing to save.");
        return refreshOnConflict(
          updateTenancyResourceFn({
            data: {
              body: sent.body,
              expectedVersion: base.version,
              idempotencyKey,
              ref: reference,
            },
          }),
          refresh,
        );
      }}
      successMessage={`${capitalized(copy.noun)} updated`}
      title={`Edit ${base.name}`}
    >
      {resource.version === base.version ? null : (
        <Callout variant="destructive">
          <CalloutTitle>This {copy.noun} changed after you opened the form</CalloutTitle>
          <CalloutDescription>
            Close the form and open it again to edit the latest values.
          </CalloutDescription>
        </Callout>
      )}
      <Field invalid={invalid("name")}>
        <Label>Name</Label>
        <Input
          aria-invalid={invalid("name")}
          autoComplete="off"
          name="name"
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          value={draft.name}
        />
      </Field>
      <Field invalid={invalid("slug")}>
        <Label>Slug</Label>
        <Description>
          Lowercase letters, digits, and hyphens, starting and ending with a letter or digit. Up to
          63 characters, unique in {copy.slugUniqueIn}. Links and scripts that use the old slug stop
          working.
        </Description>
        <Input
          aria-invalid={invalid("slug")}
          autoComplete="off"
          name="slug"
          onChange={(event) => setDraft({ ...draft, slug: event.target.value })}
          value={draft.slug}
        />
      </Field>
      {copy.describes ? (
        <Field invalid={invalid("description")}>
          <Label>Description</Label>
          <Description>Up to 2,000 characters. Leave it empty to remove it.</Description>
          <Textarea
            aria-invalid={invalid("description")}
            name="description"
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            rows={3}
            value={draft.description}
          />
        </Field>
      ) : null}
    </ActionDialog>
  );
}

function ArchiveDialog({
  onArchived,
  onClose,
  open,
  reference,
  resource,
}: Readonly<{
  onArchived: (() => void) | undefined;
  onClose: () => void;
  open: boolean;
  reference: ArchivableRef;
  resource: TenancyResource;
}>) {
  const queryClient = useQueryClient();
  const { noun } = LEVEL_COPY[reference.level];
  const refresh = () => invalidateTenancySettings(queryClient, reference);
  return (
    <ActionDialog
      confirmLabel={`Archive ${noun}`}
      confirmation={resource.slug}
      description={`Archiving ${resource.name} cannot be undone.`}
      destructive
      onClose={onClose}
      onSuccess={() => {
        void refresh();
        onArchived?.();
      }}
      open={open}
      run={(idempotencyKey) =>
        refreshOnConflict(
          archiveTenancyResourceFn({ data: { idempotencyKey, ref: reference } }),
          refresh,
        )
      }
      successMessage={`${capitalized(noun)} archived`}
      title={`Archive ${resource.name}`}
    >
      <Callout variant="destructive">
        <CalloutTitle>What archiving does</CalloutTitle>
        <CalloutDescription>
          <ul className="list-disc pl-5">
            {ARCHIVE_EFFECTS[reference.level].map((effect) => (
              <li key={effect}>{effect}</li>
            ))}
          </ul>
        </CalloutDescription>
      </Callout>
    </ActionDialog>
  );
}

function capitalized(noun: string) {
  return `${noun.charAt(0).toUpperCase()}${noun.slice(1)}`;
}
