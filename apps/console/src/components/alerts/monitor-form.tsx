import { useQuery } from "@tanstack/react-query";
import {
  checkCondition,
  isOrganizationKind,
  MONITOR_KIND_COPY,
  MONITOR_KINDS,
  MONITOR_ROLE_VALUES,
  newMonitorDraft,
  RENOTIFY_CHOICES,
  ROLE_LABELS,
  type MonitorDraft,
} from "../../alerts/monitor-model.ts";
import { memberDirectoryQuery } from "../../data/membership-queries.ts";
import { useInstallCopy } from "../../edition.ts";
import { memberName } from "../../members/roles.ts";
import { oneOf } from "../../observability/range.ts";
import type { OrganizationShell } from "../../server/console-data.ts";
import { Checkbox } from "@/components/ui/checkbox";
import {
  CheckboxField,
  Description,
  ErrorMessage,
  Field,
  Fieldset,
  Label,
  Legend,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Text } from "@/components/ui/text";

type Projects = OrganizationShell["projects"];

function activeEnvironments(projects: Projects) {
  return projects
    .filter(({ project }) => project.status === "active")
    .flatMap(({ environments, project }) =>
      environments
        .filter((environment) => environment.status === "active")
        .map((environment) => ({ environment, project })),
    );
}

export function projectOfEnvironment(projects: Projects, environmentId: string) {
  return activeEnvironments(projects).find(({ environment }) => environment.id === environmentId)
    ?.project.id;
}

function toggled<Item>(items: readonly Item[], item: Item, on: boolean): readonly Item[] {
  return on ? [...new Set([...items, item])] : items.filter((candidate) => candidate !== item);
}

/** The kind picker, offered only while creating: a monitor's kind is fixed once it exists. */
export function KindField({
  draft,
  onChange,
}: Readonly<{ draft: MonitorDraft; onChange: (draft: MonitorDraft) => void }>) {
  const installCopy = useInstallCopy();
  const { summary } = MONITOR_KIND_COPY[draft.kind];
  return (
    <Field>
      <Label>What to watch</Label>
      <Description>{typeof summary === "function" ? summary(installCopy) : summary}</Description>
      <NativeSelect
        onChange={(event) => {
          const kind = oneOf(MONITOR_KINDS, event.target.value);
          if (kind) {
            onChange({ ...newMonitorDraft(kind, draft.environmentId), name: draft.name });
          }
        }}
        value={draft.kind}
      >
        {MONITOR_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {MONITOR_KIND_COPY[kind].label}
            {isOrganizationKind(kind) ? " (organization)" : ""}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}

export function EnvironmentField({
  draft,
  onChange,
  projects,
}: Readonly<{
  draft: MonitorDraft;
  onChange: (draft: MonitorDraft) => void;
  projects: Projects;
}>) {
  if (isOrganizationKind(draft.kind)) {
    return <Text>This monitor watches the whole organization.</Text>;
  }
  const choices = activeEnvironments(projects);
  return (
    <Field>
      <Label>Environment</Label>
      {choices.length === 0 ? (
        <Description>The organization has no active environment to watch.</Description>
      ) : (
        <NativeSelect
          onChange={(event) => onChange({ ...draft, environmentId: event.target.value })}
          value={draft.environmentId}
        >
          <option disabled value="">
            Choose an environment
          </option>
          {choices.map(({ environment, project }) => (
            <option key={environment.id} value={environment.id}>
              {project.name} / {environment.name} ({environment.type})
            </option>
          ))}
        </NativeSelect>
      )}
    </Field>
  );
}

/** The fields of the draft's kind, checked against the contract as they change. */
export function ConditionFields({
  draft,
  onChange,
}: Readonly<{ draft: MonitorDraft; onChange: (draft: MonitorDraft) => void }>) {
  const fields = MONITOR_KIND_COPY[draft.kind].fields;
  if (fields.length === 0) return null;
  const check = checkCondition(draft);
  return (
    <Fieldset>
      <Legend>Condition</Legend>
      {fields.map((field) => {
        const error = !check.ok && check.field === field.name ? check.message : undefined;
        return (
          <Field key={field.name}>
            <Label>
              {field.label}
              {field.kind === "number" && field.unit ? ` (${field.unit})` : ""}
            </Label>
            <Description>{field.description}</Description>
            <Input
              aria-invalid={error ? true : undefined}
              inputMode={field.kind === "number" ? "numeric" : undefined}
              name={field.name}
              onChange={(event) =>
                onChange({
                  ...draft,
                  values: { ...draft.values, [field.name]: event.target.value },
                })
              }
              placeholder={field.kind === "text" ? field.placeholder : undefined}
              value={draft.values[field.name] ?? ""}
            />
            {error ? <ErrorMessage>{error}</ErrorMessage> : null}
          </Field>
        );
      })}
    </Fieldset>
  );
}

/** Recipients: organization roles, named members, and webhook delivery, plus the repeat policy. */
export function NotifyFields({
  draft,
  onChange,
  open,
  organizationId,
}: Readonly<{
  draft: MonitorDraft;
  onChange: (draft: MonitorDraft) => void;
  open: boolean;
  organizationId: string;
}>) {
  const members = useQuery({ ...memberDirectoryQuery(organizationId), enabled: open });
  const active = (members.data ?? []).filter((member) => member.status === "active");
  return (
    <>
      <Fieldset>
        <Legend>Email</Legend>
        <Text>
          Alert email goes only to members of this organization. Each member can turn alert email
          off for themselves.
        </Text>
        {MONITOR_ROLE_VALUES.map((role) => (
          <CheckboxField key={role}>
            <Checkbox
              checked={draft.emailRoles.includes(role)}
              onCheckedChange={(on) =>
                onChange({ ...draft, emailRoles: toggled(draft.emailRoles, role, on) })
              }
            />
            <Label>{ROLE_LABELS[role]}</Label>
          </CheckboxField>
        ))}
        {members.isPending ? (
          <Description>Loading members…</Description>
        ) : active.length === 0 ? null : (
          <Field>
            <Label>Also email these members</Label>
            <div className="flex max-h-40 flex-col gap-2 overflow-y-auto rounded-md border p-3">
              {active.map((member) => (
                <CheckboxField key={member.principalId}>
                  <Checkbox
                    checked={draft.emailPrincipalIds.includes(member.principalId)}
                    onCheckedChange={(on) =>
                      onChange({
                        ...draft,
                        emailPrincipalIds: toggled(draft.emailPrincipalIds, member.principalId, on),
                      })
                    }
                  />
                  <Label>
                    {memberName(member)}
                    {member.primaryEmail && member.displayName ? (
                      <span className="text-muted-foreground"> · {member.primaryEmail}</span>
                    ) : null}
                  </Label>
                </CheckboxField>
              ))}
            </div>
          </Field>
        )}
      </Fieldset>
      <CheckboxField>
        <Checkbox
          checked={draft.webhooks}
          onCheckedChange={(webhooks) => onChange({ ...draft, webhooks })}
        />
        <Label>Send webhook events</Label>
        <Description>
          Records <code>alert.fired</code>, <code>alert.renotified</code>, and{" "}
          <code>alert.resolved</code> for webhook endpoints that list them.
        </Description>
      </CheckboxField>
      <Field>
        <Label>While it stays firing</Label>
        <Description>
          One incident sends one alert and one all-clear unless you repeat the alert.
        </Description>
        <NativeSelect
          onChange={(event) =>
            onChange({
              ...draft,
              renotifyMinutes: RENOTIFY_CHOICES.find(
                (choice) => String(choice.minutes) === event.target.value,
              )?.minutes,
            })
          }
          value={String(draft.renotifyMinutes)}
        >
          {RENOTIFY_CHOICES.map((choice) => (
            <option key={choice.label} value={String(choice.minutes)}>
              {choice.label}
            </option>
          ))}
          {RENOTIFY_CHOICES.some((choice) => choice.minutes === draft.renotifyMinutes) ? null : (
            <option value={String(draft.renotifyMinutes)}>
              Every {draft.renotifyMinutes} minutes
            </option>
          )}
        </NativeSelect>
      </Field>
    </>
  );
}
