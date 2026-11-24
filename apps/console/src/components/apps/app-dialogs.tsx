import type {
  AppReleaseResponse,
  AppResponse,
  SetAppPublicationRequest,
} from "@deployments-ai/api-contract";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { APP_ACCESS_LEVELS, APP_GRANT_ROLES, type GrantRow } from "../../apps/app-state.ts";
import {
  APP_AUDIENCES,
  APP_SERVINGS,
  AUDIENCE_CHOICES,
  SERVING_CHOICES,
} from "../../apps/publication.ts";
import {
  archiveAppFn,
  eraseAppFn,
  promoteAppReleaseFn,
  putAppGrantFn,
  removeAppGrantFn,
  setAppPublicationFn,
  updateAppFn,
} from "../../data/app-mutations.ts";
import { appGrantsQuery, invalidateApps } from "../../data/app-queries.ts";
import { environmentQuery } from "../../data/console-queries.ts";
import { oneOf } from "../../observability/range.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Description, Field, Fieldset, Label, Legend, RadioField } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ActionDialog, refreshOnConflict, typedConfirmation } from "../action-dialog.tsx";
import { useKeyedSnapshot } from "../keyed-snapshot.ts";

export type AppDialog =
  | { readonly kind: "access" }
  | { readonly kind: "add-grant" }
  | { readonly kind: "archive" }
  | { readonly kind: "erase" }
  | { readonly kind: "promote"; readonly release: AppReleaseResponse }
  | { readonly kind: "publication" }
  | { readonly kind: "remove-grant"; readonly grant: GrantRow };

const ACCESS_DESCRIPTIONS: Readonly<Record<(typeof APP_ACCESS_LEVELS)[number], string>> = {
  editor: "Every member calls read and write functions.",
  none: "Only members with a grant open the app.",
  viewer: "Every member calls read functions.",
};

interface DialogProps {
  readonly app: AppResponse;
  readonly onClose: () => void;
  readonly scope: EnvironmentScope;
}

export function AppDialogs({
  dialog,
  ...props
}: DialogProps & { readonly dialog: AppDialog | undefined }) {
  switch (dialog?.kind) {
    case undefined:
      return null;
    case "access":
      return <AccessDialog {...props} />;
    case "add-grant":
      return <AddGrantDialog {...props} />;
    case "archive":
      return <ArchiveDialog {...props} />;
    case "erase":
      return <EraseDialog {...props} />;
    case "promote":
      return <PromoteDialog {...props} release={dialog.release} />;
    case "publication":
      return <PublicationDialog {...props} />;
    case "remove-grant":
      return <RemoveGrantDialog {...props} grant={dialog.grant} />;
    default: {
      const unhandled: never = dialog;
      return unhandled;
    }
  }
}

function AccessDialog({ app, onClose, scope }: DialogProps) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const current = app.access.organizationMembers;
  const [level, setLevel] = useState(current);
  return (
    <ActionDialog
      confirmLabel="Save access"
      confirmation={typedConfirmation(environment.type, { phrase: app.slug })}
      description="Grants still apply on top of this level."
      invalid={level === current}
      onClose={onClose}
      onSuccess={() => void invalidateApps(queryClient, scope)}
      open
      run={(idempotencyKey) =>
        refreshOnConflict(
          updateAppFn({
            data: {
              appId: app.id,
              body: { access: { organizationMembers: level } },
              idempotencyKey,
              scope,
            },
          }),
          () => invalidateApps(queryClient, scope),
        )
      }
      successMessage={(updated) => `Member access set to ${updated.access.organizationMembers}`}
      title={`Member access to ${app.name}`}
    >
      <Field>
        <Label>Every organization member</Label>
        <Description>{ACCESS_DESCRIPTIONS[level]}</Description>
        <NativeSelect
          name="access"
          onChange={(event) => {
            const next = oneOf(APP_ACCESS_LEVELS, event.target.value);
            if (next) setLevel(next);
          }}
          value={level}
        >
          {APP_ACCESS_LEVELS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </NativeSelect>
      </Field>
    </ActionDialog>
  );
}

function PublicationDialog({ app, onClose, scope }: DialogProps) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const current = app.publication;
  const [draft, setDraft] = useState(current);
  const widens = draft.audience === "public" && current.audience !== "public";
  const change: SetAppPublicationRequest = {
    ...(draft.audience === current.audience ? {} : { audience: draft.audience }),
    ...(draft.serving === current.serving ? {} : { serving: draft.serving }),
  };
  const held = useKeyedSnapshot<SetAppPublicationRequest>();
  return (
    <ActionDialog
      confirmLabel="Save publication"
      confirmation={typedConfirmation(environment.type, { destructive: widens, phrase: app.slug })}
      description={
        widens
          ? "Before an app first goes public, the platform prepares its database for visitors. The setting changes only once that step succeeds, and the app cannot be deleted for 10 minutes after the step starts."
          : "The change applies to the next page load."
      }
      invalid={Object.keys(change).length === 0}
      onClose={onClose}
      onSuccess={() => void invalidateApps(queryClient, scope)}
      open
      retryNotice="The platform may have started preparing the database for visitors. Submit again to finish under the same request. The setting changes only after that step succeeds."
      run={(idempotencyKey, resend) =>
        refreshOnConflict(
          setAppPublicationFn({
            data: {
              appId: app.id,
              body: held(idempotencyKey, resend, change),
              idempotencyKey,
              scope,
            },
          }),
          () => invalidateApps(queryClient, scope),
        )
      }
      successMessage={(updated) =>
        `${AUDIENCE_CHOICES[updated.publication.audience].label}, served as a ${SERVING_CHOICES[updated.publication.serving].label.toLowerCase()}`
      }
      title={`Publication of ${app.name}`}
    >
      <Fieldset>
        <Legend>Audience</Legend>
        <RadioGroup
          onValueChange={(value: string) => {
            const audience = oneOf(APP_AUDIENCES, value);
            if (audience) setDraft({ ...draft, audience });
          }}
          value={draft.audience}
        >
          {APP_AUDIENCES.map((audience) => (
            <RadioField key={audience}>
              <RadioGroupItem value={audience} />
              <Label>{AUDIENCE_CHOICES[audience].label}</Label>
              <Description>{AUDIENCE_CHOICES[audience].description}</Description>
            </RadioField>
          ))}
        </RadioGroup>
      </Fieldset>
      <Fieldset>
        <Legend>Serving</Legend>
        <RadioGroup
          onValueChange={(value: string) => {
            const serving = oneOf(APP_SERVINGS, value);
            if (serving) setDraft({ ...draft, serving });
          }}
          value={draft.serving}
        >
          {APP_SERVINGS.map((serving) => (
            <RadioField key={serving}>
              <RadioGroupItem value={serving} />
              <Label>{SERVING_CHOICES[serving].label}</Label>
              <Description>{SERVING_CHOICES[serving].description}</Description>
            </RadioField>
          ))}
        </RadioGroup>
      </Fieldset>
    </ActionDialog>
  );
}

function AddGrantDialog({ app, onClose, scope }: DialogProps) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const { data: directory } = useSuspenseQuery(appGrantsQuery(scope, app.id));
  const [principalId, setPrincipalId] = useState("");
  const [role, setRole] = useState<(typeof APP_GRANT_ROLES)[number]>("viewer");
  const member = directory.candidates.find((candidate) => candidate.principalId === principalId);
  return (
    <ActionDialog
      confirmLabel="Add grant"
      confirmation={typedConfirmation(environment.type, { phrase: app.slug })}
      description={
        directory.candidates.length === 0
          ? "Every active member already has a grant."
          : "Viewers call read functions, and editors also call write functions."
      }
      invalid={member === undefined}
      onClose={onClose}
      onSuccess={() => void invalidateApps(queryClient, scope)}
      open
      run={(idempotencyKey) =>
        putAppGrantFn({
          data: { appId: app.id, body: { role }, idempotencyKey, principalId, scope },
        })
      }
      successMessage={`${member?.name ?? "Member"} is now ${role}`}
      title={`Add a grant to ${app.name}`}
    >
      <Field>
        <Label>Member</Label>
        <NativeSelect
          name="member"
          onChange={(event) => setPrincipalId(event.target.value)}
          value={principalId}
        >
          <option disabled value="">
            Choose a member
          </option>
          {directory.candidates.map((candidate) => (
            <option key={candidate.principalId} value={candidate.principalId}>
              {candidate.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field>
        <Label>Role</Label>
        <NativeSelect
          name="role"
          onChange={(event) => {
            const next = oneOf(APP_GRANT_ROLES, event.target.value);
            if (next) setRole(next);
          }}
          value={role}
        >
          {APP_GRANT_ROLES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </NativeSelect>
      </Field>
    </ActionDialog>
  );
}

function RemoveGrantDialog({
  app,
  grant,
  onClose,
  scope,
}: DialogProps & { readonly grant: GrantRow }) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  return (
    <ActionDialog
      confirmLabel="Revoke grant"
      confirmation={typedConfirmation(environment.type, { destructive: true, phrase: app.slug })}
      description={`${grant.name} keeps only the access every member has.`}
      destructive
      onClose={onClose}
      onSuccess={() => void invalidateApps(queryClient, scope)}
      open
      run={(idempotencyKey) =>
        refreshOnConflict(
          removeAppGrantFn({
            data: { appId: app.id, idempotencyKey, principalId: grant.principalId, scope },
          }),
          () => invalidateApps(queryClient, scope),
        )
      }
      successMessage="Grant revoked"
      title={`Revoke the ${grant.role} grant of ${grant.name}?`}
    />
  );
}

function PromoteDialog({
  app,
  onClose,
  release,
  scope,
}: DialogProps & { readonly release: AppReleaseResponse }) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  return (
    <ActionDialog
      confirmLabel="Promote"
      confirmation={typedConfirmation(environment.type, { live: true, phrase: app.slug })}
      description="Members get this release on their next page load. Promoting an earlier release is a rollback."
      onClose={onClose}
      onSuccess={() => void invalidateApps(queryClient, scope)}
      open
      run={(idempotencyKey) =>
        refreshOnConflict(
          promoteAppReleaseFn({
            data: { appId: app.id, idempotencyKey, releaseId: release.id, scope },
          }),
          () => invalidateApps(queryClient, scope),
        )
      }
      successMessage="Release promoted"
      title={`Promote release …${release.id.slice(-8)}`}
    />
  );
}

function ArchiveDialog({ app, onClose, scope }: DialogProps) {
  const queryClient = useQueryClient();
  return (
    <ActionDialog
      confirmLabel="Archive app"
      confirmation={app.slug}
      description="The app stops serving members and agents. An archived app cannot be reactivated, only deleted."
      destructive
      onClose={onClose}
      onSuccess={() => void invalidateApps(queryClient, scope)}
      open
      run={(idempotencyKey) =>
        refreshOnConflict(archiveAppFn({ data: { appId: app.id, idempotencyKey, scope } }), () =>
          invalidateApps(queryClient, scope),
        )
      }
      successMessage="App archived"
      title={`Archive ${app.name}?`}
    />
  );
}

function EraseDialog({ app, onClose, scope }: DialogProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return (
    <ActionDialog
      confirmLabel="Delete app"
      confirmation={app.slug}
      description={`Deletes the app's database, releases, and grants. ${app.url} is never reused.`}
      destructive
      onClose={onClose}
      onSuccess={() =>
        void navigate({
          params: {
            envId: scope.environmentId,
            orgId: scope.organizationId,
            projectId: scope.projectId,
          },
          to: "/o/$orgId/p/$projectId/e/$envId/apps",
        }).then(() => invalidateApps(queryClient, scope))
      }
      open
      run={(idempotencyKey) => eraseAppFn({ data: { appId: app.id, idempotencyKey, scope } })}
      successMessage="App deletion started"
      title={`Delete ${app.name}?`}
    />
  );
}
