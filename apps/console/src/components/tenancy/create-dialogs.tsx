import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { invalidateTenancy, organizationShellQuery } from "../../data/console-queries.ts";
import {
  createEnvironmentFn,
  createOrganizationFn,
  createProjectFn,
} from "../../data/tenancy-mutations.ts";
import type { EnvironmentSummary } from "../../server/console-data.ts";
import { isSlug, slugFromName } from "../../tenancy/slug.ts";
import { Description, Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { ActionDialog } from "../action-dialog.tsx";
import { isResourceName } from "../api-keys/service-account-dialogs.tsx";

/** `slug` stays `undefined` while it follows the name; the first edit to the slug field pins it. */
interface NameAndSlug {
  readonly name: string;
  readonly slug: string | undefined;
}

const UNNAMED: NameAndSlug = { name: "", slug: undefined };

interface ResolvedNameAndSlug {
  readonly body: { readonly name: string; readonly slug: string };
  readonly invalid: boolean;
}

function resolveDraft({ name, slug }: NameAndSlug): ResolvedNameAndSlug {
  const body = { name: name.trim(), slug: slug ?? slugFromName(name) };
  return { body, invalid: !isResourceName(body.name) || !isSlug(body.slug) };
}

function NameAndSlugFields({
  onChange,
  uniqueIn,
  value,
}: Readonly<{ onChange: (value: NameAndSlug) => void; uniqueIn: string; value: NameAndSlug }>) {
  const { name, slug } = resolveDraft(value).body;
  return (
    <>
      <Field>
        <Label>Name</Label>
        <Input
          aria-invalid={value.name !== "" && !isResourceName(name)}
          autoComplete="off"
          name="name"
          onChange={(event) => onChange({ ...value, name: event.target.value })}
          value={value.name}
        />
      </Field>
      <Field>
        <Label>Slug</Label>
        <Description>
          Lowercase letters, digits, and hyphens, starting and ending with a letter or digit. Up to
          63 characters, unique in {uniqueIn}.
        </Description>
        <Input
          aria-invalid={slug !== "" && !isSlug(slug)}
          autoComplete="off"
          name="slug"
          onChange={(event) => onChange({ ...value, slug: event.target.value })}
          value={slug}
        />
      </Field>
    </>
  );
}

export function CreateOrganizationDialog({ onClose }: Readonly<{ onClose: () => void }>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [draft, setDraft] = useState(UNNAMED);
  const { body, invalid } = resolveDraft(draft);
  return (
    <ActionDialog
      confirmLabel="Create organization"
      description="You become its owner and can invite others from Members."
      invalid={invalid}
      onClose={onClose}
      onSuccess={(organization) =>
        void invalidateTenancy(queryClient).then(() =>
          navigate({ params: { orgId: organization.id }, to: "/o/$orgId" }),
        )
      }
      open
      run={(idempotencyKey: string) =>
        createOrganizationFn({ data: { body, idempotencyKey, scope: {} } })
      }
      successMessage="Organization created"
      title="Create organization"
    >
      <NameAndSlugFields onChange={setDraft} uniqueIn="this install" value={draft} />
    </ActionDialog>
  );
}

export function CreateProjectDialog({
  onClose,
  onCreated,
  organizationId,
}: Readonly<{
  onClose: () => void;
  onCreated: (project: { readonly id: string; readonly name: string }) => void;
  organizationId: string;
}>) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(UNNAMED);
  const { body, invalid } = resolveDraft(draft);
  return (
    <ActionDialog
      confirmLabel="Create project"
      description="A project groups related environments, such as development and production."
      invalid={invalid}
      onClose={onClose}
      onSuccess={(project) => {
        void queryClient.invalidateQueries({
          queryKey: organizationShellQuery(organizationId).queryKey,
        });
        onCreated(project);
      }}
      open
      run={(idempotencyKey: string) =>
        createProjectFn({ data: { body, idempotencyKey, scope: { organizationId } } })
      }
      successMessage="Project created"
      title="Create project"
    >
      <NameAndSlugFields onChange={setDraft} uniqueIn="this organization" value={draft} />
    </ActionDialog>
  );
}

const ENVIRONMENT_TYPES = [
  { label: "Development", value: "development" },
  { label: "Staging", value: "staging" },
  { label: "Production", value: "production" },
  { label: "Custom", value: "custom" },
] as const satisfies readonly {
  readonly label: string;
  readonly value: EnvironmentSummary["type"];
}[];

export function CreateEnvironmentDialog({
  onClose,
  organizationId,
  project,
}: Readonly<{
  onClose: () => void;
  organizationId: string;
  project: { readonly id: string; readonly name: string };
}>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<NameAndSlug>({ name: "Development", slug: undefined });
  const [type, setType] = useState<EnvironmentSummary["type"]>("development");
  const { body, invalid } = resolveDraft(draft);
  return (
    <ActionDialog
      confirmLabel="Create environment"
      description="Agents, runs, and API keys belong to one environment."
      invalid={invalid}
      onClose={onClose}
      onSuccess={(environment) =>
        void queryClient
          .invalidateQueries({ queryKey: organizationShellQuery(organizationId).queryKey })
          .then(() =>
            navigate({
              params: { envId: environment.id, orgId: organizationId, projectId: project.id },
              to: "/o/$orgId/p/$projectId/e/$envId",
            }),
          )
      }
      open
      run={(idempotencyKey: string) =>
        createEnvironmentFn({
          data: {
            body: { ...body, type },
            idempotencyKey,
            scope: { organizationId, projectId: project.id },
          },
        })
      }
      successMessage="Environment created"
      title={`Create an environment in ${project.name}`}
    >
      <NameAndSlugFields onChange={setDraft} uniqueIn={project.name} value={draft} />
      <Field>
        <Label>Type</Label>
        <Description>
          Production environments ask you to type a confirmation before every change.
        </Description>
        <NativeSelect
          onChange={(event) => {
            const chosen = ENVIRONMENT_TYPES.find((option) => option.value === event.target.value);
            if (chosen) setType(chosen.value);
          }}
          value={type}
        >
          {ENVIRONMENT_TYPES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
    </ActionDialog>
  );
}
