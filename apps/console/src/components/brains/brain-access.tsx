import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { BrainResponse } from "@deployments-ai/api-contract/brains";
import {
  activeRecord,
  BRAIN_RETRY_NOTICES,
  grantablePeople,
  grantKindsFor,
  grantRequest,
  mountRefusal,
  revokeRefusal,
  type BrainGrant,
  type BrainMount,
  type GrantDraft,
  type MachineGrantPermission,
  type MountBody,
} from "../../brains/model.ts";
import {
  createBrainGrantFn,
  createBrainMountFn,
  revokeBrainGrantFn,
  revokeBrainMountFn,
} from "../../data/brain-mutations.ts";
import { brainGrantsQuery, brainMountsQuery, invalidateBrain } from "../../data/brain-queries.ts";
import { environmentQuery } from "../../data/console-queries.ts";
import { memberDirectoryQuery } from "../../data/membership-queries.ts";
import type { MemberView } from "../../members/roles.ts";
import { agentDirectoryQuery } from "../../data/observability-queries.ts";
import { oneOf } from "../../observability/range.ts";
import type { EnvironmentScope } from "../../scope.ts";
import type { EnvironmentSummary } from "../../server/console-data.ts";
import { Button } from "@/components/ui/button";
import { Description, Field, Label } from "@/components/ui/field";
import { Subheading } from "@/components/ui/heading";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Text } from "@/components/ui/text";
import { ActionDialog, refreshOnConflict, typedConfirmation } from "../action-dialog.tsx";
import { deploymentPhrase } from "../agents/deployment-actions.tsx";
import { Icon } from "../icon.tsx";
import { useKeyedSnapshot } from "../keyed-snapshot.ts";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { StatusBadge } from "@/components/status-badge";

const GRANT_KIND_LABELS: Readonly<Record<GrantDraft["kind"], string>> = {
  "agent-definition": "An agent in this environment",
  "organization-role": "Everyone with an organization role",
  principal: "A person in the organization",
  "service-account": "A service account in this environment",
};

const PEOPLE_PERMISSIONS = ["reader", "writer", "curator", "owner"] as const;
const ROLE_PERMISSIONS = ["reader", "writer", "curator"] as const;
const ORGANIZATION_ROLES = ["member", "admin", "owner"] as const;
const MACHINE_PERMISSIONS = [
  "read",
  "read-write",
] as const satisfies readonly MachineGrantPermission[];

type EnvironmentType = EnvironmentSummary["type"];

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

interface Names {
  readonly agents: ReadonlyMap<string, string>;
  readonly members: readonly MemberView[];
  readonly people: ReadonlyMap<string, string>;
}

function useNames(scope: EnvironmentScope): Names {
  const { data: directory } = useSuspenseQuery(agentDirectoryQuery(scope));
  const { data: members } = useSuspenseQuery(memberDirectoryQuery(scope.organizationId));
  return {
    agents: new Map(directory.definitions.map((definition) => [definition.id, definition.name])),
    members,
    people: new Map(
      members.map((member) => [
        member.principalId,
        member.displayName ?? member.primaryEmail ?? member.principalId,
      ]),
    ),
  };
}

function TargetLabel({ names, target }: Readonly<{ names: Names; target: BrainGrant["target"] }>) {
  switch (target.type) {
    case "principal":
      return names.people.get(target.principalId) ?? <PublicId value={target.principalId} />;
    case "organization-role":
      return `Every ${target.organizationRole}`;
    case "agent-definition":
      return (
        <>
          Agent{" "}
          {names.agents.get(target.agentDefinitionId) ?? (
            <PublicId value={target.agentDefinitionId} />
          )}
        </>
      );
    case "service-account":
      return (
        <>
          Service account <PublicId value={target.serviceAccountId} />
        </>
      );
  }
}

export function BrainAccess({
  brain,
  scope,
}: Readonly<{ brain: BrainResponse; scope: EnvironmentScope }>) {
  const { data: grants } = useSuspenseQuery(brainGrantsQuery(brain.organizationId, brain.id));
  const { data: mounts } = useSuspenseQuery(brainMountsQuery(brain.organizationId, brain.id));
  const names = useNames(scope);
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [granting, setGranting] = useState(false);
  const [mounting, setMounting] = useState(false);
  const [revokingGrant, setRevokingGrant] = useState<string>();
  const [revokingMount, setRevokingMount] = useState<string>();
  const grantToRevoke = activeRecord(grants, revokingGrant);
  const mountToRevoke = activeRecord(mounts, revokingMount);
  const active = grants.filter((grant) => grant.status === "active");
  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Subheading>Grants</Subheading>
          <Button className="ml-auto" onClick={() => setGranting(true)} variant="outline">
            <Icon icon={PlusSignIcon} />
            Add grant
          </Button>
        </div>
        <Text>
          Readers search and ask; writers and curators also upload and review; owners also manage
          access and settings. Agents and service accounts read, or read and write.
        </Text>
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Who</TableHead>
              <TableHead>Permission</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Granted</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {grants.map((grant) => {
              const refusal = revokeRefusal(brain, grant, active);
              return (
                <TableRow key={grant.id}>
                  <TableCell>
                    <TargetLabel names={names} target={grant.target} />
                  </TableCell>
                  <TableCell>{grant.permission}</TableCell>
                  <TableCell>
                    <StatusBadge status={grant.status} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <Timestamp value={grant.createdAt} />
                  </TableCell>
                  <TableCell className="text-right">
                    {grant.status !== "active" ? null : refusal ? (
                      <Text>{refusal}</Text>
                    ) : (
                      <Button onClick={() => setRevokingGrant(grant.id)} variant="ghost">
                        Revoke
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </section>
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Subheading>Mounts</Subheading>
          <Button className="ml-auto" onClick={() => setMounting(true)} variant="outline">
            <Icon icon={PlusSignIcon} />
            Mount on a deployment
          </Button>
        </div>
        <Text>
          A mount gives a running agent deployment this Brain&apos;s tools, which changes how it
          answers.
        </Text>
        {mounts.length === 0 ? (
          <Text>No deployment mounts this Brain.</Text>
        ) : (
          <Table striped>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Deployment</TableHead>
                <TableHead>Permission</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Mounted</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {mounts.map((mount) => (
                <TableRow key={mount.id}>
                  <TableCell>
                    {names.agents.get(mount.agentDefinitionId) ?? (
                      <PublicId value={mount.agentDefinitionId} />
                    )}
                  </TableCell>
                  <TableCell>
                    <PublicId value={mount.agentDeploymentId} />
                  </TableCell>
                  <TableCell>{mount.permission}</TableCell>
                  <TableCell>
                    <StatusBadge status={mount.status} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <Timestamp value={mount.createdAt} />
                  </TableCell>
                  <TableCell className="text-right">
                    {mount.status === "active" ? (
                      <Button onClick={() => setRevokingMount(mount.id)} variant="ghost">
                        Unmount
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
      <GrantDialog
        brain={brain}
        environmentType={environment.type}
        grants={grants}
        names={names}
        onClose={() => setGranting(false)}
        open={granting}
        scope={scope}
      />
      <MountDialog
        brain={brain}
        environmentType={environment.type}
        grants={grants}
        onClose={() => setMounting(false)}
        open={mounting}
        scope={scope}
      />
      <RevokeDialog
        brain={brain}
        onClose={() => setRevokingGrant(undefined)}
        revoking={grantToRevoke === undefined ? undefined : { kind: "grant", grant: grantToRevoke }}
      />
      <RevokeDialog
        brain={brain}
        onClose={() => setRevokingMount(undefined)}
        revoking={mountToRevoke === undefined ? undefined : { kind: "mount", mount: mountToRevoke }}
      />
    </div>
  );
}

interface GrantForm {
  readonly agentDefinitionId: string;
  readonly kind: GrantDraft["kind"];
  readonly machinePermission: MachineGrantPermission;
  readonly organizationRole: (typeof ORGANIZATION_ROLES)[number];
  readonly peoplePermission: (typeof PEOPLE_PERMISSIONS)[number];
  readonly principalId: string;
  readonly rolePermission: (typeof ROLE_PERMISSIONS)[number];
  readonly serviceAccountId: string;
}

function grantDraft(form: GrantForm, scope: EnvironmentScope): GrantDraft | undefined {
  const environment = { environmentId: scope.environmentId, projectId: scope.projectId };
  switch (form.kind) {
    case "principal":
      return form.principalId
        ? { kind: "principal", permission: form.peoplePermission, principalId: form.principalId }
        : undefined;
    case "organization-role":
      return {
        kind: "organization-role",
        organizationRole: form.organizationRole,
        permission: form.rolePermission,
      };
    case "agent-definition":
      return form.agentDefinitionId
        ? {
            ...environment,
            agentDefinitionId: form.agentDefinitionId,
            kind: "agent-definition",
            permission: form.machinePermission,
          }
        : undefined;
    case "service-account":
      return ULID.test(form.serviceAccountId)
        ? {
            ...environment,
            kind: "service-account",
            permission: form.machinePermission,
            serviceAccountId: form.serviceAccountId,
          }
        : undefined;
  }
}

function PermissionSelect<const Values extends readonly string[]>({
  onChange,
  options,
  value,
}: Readonly<{
  onChange: (value: Values[number]) => void;
  options: Values;
  value: Values[number];
}>) {
  return (
    <Field>
      <Label>Permission</Label>
      <NativeSelect
        onChange={(event) => {
          const next = oneOf(options, event.target.value);
          if (next) onChange(next);
        }}
        value={value}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}

function GrantDialog({
  brain,
  environmentType,
  grants,
  names,
  onClose,
  open,
  scope,
}: Readonly<{
  brain: BrainResponse;
  environmentType: EnvironmentType;
  grants: readonly BrainGrant[];
  names: Names;
  onClose: () => void;
  open: boolean;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const kinds = grantKindsFor(brain.kind);
  const blank: GrantForm = {
    agentDefinitionId: "",
    kind: kinds[0] ?? "agent-definition",
    machinePermission: "read",
    organizationRole: "member",
    peoplePermission: "reader",
    principalId: "",
    rolePermission: "reader",
    serviceAccountId: "",
  };
  const [form, setForm] = useState(blank);
  const held = useKeyedSnapshot<GrantDraft | undefined>();
  const draft = grantDraft(form, scope);
  const people = grantablePeople(names.members, grants);
  const machinePhrase =
    draft?.kind === "agent-definition"
      ? (names.agents.get(draft.agentDefinitionId) ?? draft.agentDefinitionId)
      : draft?.kind === "service-account"
        ? draft.serviceAccountId.slice(-8)
        : undefined;
  return (
    <ActionDialog
      confirmLabel="Add grant"
      confirmation={
        machinePhrase === undefined
          ? undefined
          : typedConfirmation(environmentType, { phrase: machinePhrase })
      }
      invalid={draft === undefined}
      onClose={() => {
        setForm(blank);
        void invalidateBrain(queryClient, brain.organizationId, brain.id);
        onClose();
      }}
      open={open}
      retryNotice={BRAIN_RETRY_NOTICES.grant}
      run={(idempotencyKey, resend) => {
        const sent = held(idempotencyKey, resend, draft);
        if (sent === undefined) throw new TypeError("Choose who receives the grant.");
        return createBrainGrantFn({
          data: {
            body: grantRequest(sent),
            brainId: brain.id,
            idempotencyKey,
            scope: { organizationId: brain.organizationId },
          },
        });
      }}
      successMessage="Grant added"
      title={`Grant access to ${brain.name}`}
    >
      <Field>
        <Label>Who</Label>
        <NativeSelect
          onChange={(event) => {
            const kind = oneOf(kinds, event.target.value);
            if (kind) setForm({ ...form, kind });
          }}
          value={form.kind}
        >
          {kinds.map((kind) => (
            <option key={kind} value={kind}>
              {GRANT_KIND_LABELS[kind]}
            </option>
          ))}
        </NativeSelect>
        {brain.kind === "member-private" ? (
          <Description>
            A private Brain can be shared only with agents and service accounts.
          </Description>
        ) : null}
      </Field>
      {form.kind === "principal" ? (
        <>
          <Field>
            <Label>Person</Label>
            <NativeSelect
              onChange={(event) => setForm({ ...form, principalId: event.target.value })}
              value={form.principalId}
            >
              <option value="">Choose a member</option>
              {people.map(({ principalId }) => (
                <option key={principalId} value={principalId}>
                  {names.people.get(principalId)}
                </option>
              ))}
            </NativeSelect>
            <Description>
              Active members who hold no grant on this Brain. Change an existing grant by revoking
              it and adding a new one.
            </Description>
          </Field>
          <PermissionSelect
            onChange={(peoplePermission) => setForm({ ...form, peoplePermission })}
            options={PEOPLE_PERMISSIONS}
            value={form.peoplePermission}
          />
        </>
      ) : null}
      {form.kind === "organization-role" ? (
        <>
          <Field>
            <Label>Organization role</Label>
            <Description>Viewers and billing members never match a role grant.</Description>
            <NativeSelect
              onChange={(event) => {
                const organizationRole = oneOf(ORGANIZATION_ROLES, event.target.value);
                if (organizationRole) setForm({ ...form, organizationRole });
              }}
              value={form.organizationRole}
            >
              {ORGANIZATION_ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <PermissionSelect
            onChange={(rolePermission) => setForm({ ...form, rolePermission })}
            options={ROLE_PERMISSIONS}
            value={form.rolePermission}
          />
        </>
      ) : null}
      {form.kind === "agent-definition" ? (
        <Field>
          <Label>Agent</Label>
          <NativeSelect
            onChange={(event) => setForm({ ...form, agentDefinitionId: event.target.value })}
            value={form.agentDefinitionId}
          >
            <option value="">Choose an agent</option>
            {[...names.agents].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </NativeSelect>
        </Field>
      ) : null}
      {form.kind === "service-account" ? (
        <Field invalid={form.serviceAccountId !== "" && !ULID.test(form.serviceAccountId)}>
          <Label>Service account ID</Label>
          <Description>Copy it from Access › API keys in this environment.</Description>
          <Input
            autoComplete="off"
            aria-invalid={form.serviceAccountId !== "" && !ULID.test(form.serviceAccountId)}
            onChange={(event) => setForm({ ...form, serviceAccountId: event.target.value.trim() })}
            value={form.serviceAccountId}
          />
        </Field>
      ) : null}
      {form.kind === "agent-definition" || form.kind === "service-account" ? (
        <PermissionSelect
          onChange={(machinePermission) => setForm({ ...form, machinePermission })}
          options={MACHINE_PERMISSIONS}
          value={form.machinePermission}
        />
      ) : null}
    </ActionDialog>
  );
}

function MountDialog({
  brain,
  environmentType,
  grants,
  onClose,
  open,
  scope,
}: Readonly<{
  brain: BrainResponse;
  environmentType: EnvironmentType;
  grants: readonly BrainGrant[];
  onClose: () => void;
  open: boolean;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const { data: directory } = useSuspenseQuery(agentDirectoryQuery(scope));
  const [deploymentId, setDeploymentId] = useState("");
  const [permission, setPermission] = useState<MachineGrantPermission>("read");
  const held = useKeyedSnapshot<MountBody | undefined>();
  const agentName = new Map(
    directory.definitions.map((definition) => [definition.id, definition.name]),
  );
  const deployment = directory.deployments.find((candidate) => candidate.id === deploymentId);
  const target =
    deployment === undefined
      ? undefined
      : {
          agentDefinitionId: deployment.definitionId,
          environmentId: scope.environmentId,
          projectId: scope.projectId,
        };
  const refusal = target === undefined ? undefined : mountRefusal(target, permission, grants);
  const body: MountBody | undefined =
    target === undefined ? undefined : { ...target, agentDeploymentId: deploymentId, permission };
  return (
    <ActionDialog
      confirmLabel="Mount"
      confirmation={
        deployment === undefined
          ? undefined
          : typedConfirmation(environmentType, { phrase: deploymentPhrase(deployment) })
      }
      description="The deployment's agent starts using this Brain's tools on its next run."
      invalid={target === undefined || refusal !== undefined}
      onClose={() => {
        setDeploymentId("");
        setPermission("read");
        void invalidateBrain(queryClient, brain.organizationId, brain.id);
        onClose();
      }}
      open={open}
      retryNotice={BRAIN_RETRY_NOTICES.mount}
      run={(idempotencyKey, resend) => {
        const sent = held(idempotencyKey, resend, body);
        if (sent === undefined) throw new TypeError("Choose a deployment.");
        return createBrainMountFn({
          data: {
            body: sent,
            brainId: brain.id,
            idempotencyKey,
            scope: { organizationId: brain.organizationId },
          },
        });
      }}
      successMessage="Mounted"
      title={`Mount ${brain.name}`}
    >
      <Field>
        <Label>Deployment in this environment</Label>
        <NativeSelect
          onChange={(event) => setDeploymentId(event.target.value)}
          value={deploymentId}
        >
          <option value="">Choose a deployment</option>
          {directory.deployments.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {agentName.get(candidate.definitionId) ?? candidate.definitionId} · …
              {candidate.id.slice(-8)}
            </option>
          ))}
        </NativeSelect>
        <Description>A stopped deployment cannot take a mount.</Description>
      </Field>
      <PermissionSelect onChange={setPermission} options={MACHINE_PERMISSIONS} value={permission} />
      {refusal ? <Text>{refusal}</Text> : null}
    </ActionDialog>
  );
}

type Revoking =
  | { readonly kind: "grant"; readonly grant: BrainGrant }
  | { readonly kind: "mount"; readonly mount: BrainMount };

function RevokeDialog({
  brain,
  onClose,
  revoking,
}: Readonly<{ brain: BrainResponse; onClose: () => void; revoking: Revoking | undefined }>) {
  const queryClient = useQueryClient();
  const refresh = () => invalidateBrain(queryClient, brain.organizationId, brain.id);
  const scope = { organizationId: brain.organizationId };
  const held = useKeyedSnapshot<Revoking | undefined>();
  return (
    <ActionDialog
      confirmLabel={revoking?.kind === "mount" ? "Unmount" : "Revoke"}
      confirmation={revoking?.kind === "mount" ? "unmount" : "revoke"}
      description={
        revoking?.kind === "mount"
          ? "The deployment's agent loses this Brain's tools. Mount it again to restore them."
          : "The grantee loses this access at once. Add a new grant to restore it."
      }
      destructive
      onClose={onClose}
      onSuccess={() => void refresh()}
      open={revoking !== undefined}
      retryNotice={BRAIN_RETRY_NOTICES.revoke}
      run={(idempotencyKey, resend) => {
        const sent = held(idempotencyKey, resend, revoking);
        if (sent === undefined) throw new TypeError("Nothing to revoke.");
        return refreshOnConflict<unknown>(
          sent.kind === "grant"
            ? revokeBrainGrantFn({
                data: {
                  brainId: brain.id,
                  expectedVersion: sent.grant.version,
                  grantId: sent.grant.id,
                  idempotencyKey,
                  scope,
                },
              })
            : revokeBrainMountFn({
                data: {
                  brainId: brain.id,
                  expectedVersion: sent.mount.version,
                  idempotencyKey,
                  mountId: sent.mount.id,
                  scope,
                },
              }),
          refresh,
        );
      }}
      successMessage={revoking?.kind === "mount" ? "Unmounted" : "Grant revoked"}
      title={revoking?.kind === "mount" ? "Unmount this deployment?" : "Revoke this grant?"}
    />
  );
}
