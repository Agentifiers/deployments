import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import type { ConnectionView } from "../../connections/connection-state.ts";
import { appChoice } from "../../connections/oauth.ts";
import {
  revokeOldStep,
  type RebindObservation,
  type RebindPhase,
  type ReauthorizeSearch,
} from "../../connections/rebind.ts";
import {
  providerCatalogQuery,
  rebindObservationQuery,
  rereadOnConflict,
} from "../../data/connection-queries.ts";
import { beginAuthorizationFn } from "../../data/oauth-app-mutations.ts";
import { oauthAppsQuery } from "../../data/oauth-app-queries.ts";
import { UnauthenticatedError } from "../../errors.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Checkbox } from "@/components/ui/checkbox";
import { CheckboxField, Description, Label, RadioField } from "@/components/ui/field";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Subheading } from "@/components/ui/heading";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Text } from "@/components/ui/text";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { describeProblem, ProblemReference } from "../section-boundary.tsx";
import { RevokeConnectionDialog } from "./connection-dialogs.tsx";
import { CONSENT_NOTICE, TenantField } from "./credential-dialogs.tsx";
import { OAuthAppPicker } from "./oauth-app-picker.tsx";

export type ReauthorizePhase = Extract<
  RebindPhase,
  { readonly kind: "awaiting-authorization" | "authorization-failed" | "revoking-old" }
>;

const FAILURE_COPY: Readonly<
  Record<Extract<RebindPhase, { kind: "authorization-failed" }>["error"], string>
> = {
  access_denied: "The provider's consent page was declined, so no connection was created.",
  authorization_failed: "The platform could not finish the authorization with the provider.",
  "wrong-provider":
    "The authorization that came back names a connection this environment does not have, a connection for another provider, or one older than this reauthorization.",
};

function accountOf(connection: ConnectionView) {
  return connection.externalAccountName ?? connection.externalAccountId;
}

/** What the current reauthorization phase means, below the phase title. */
export function ReauthorizePhaseDetail({
  observation,
  phase,
}: Readonly<{ observation: RebindObservation; phase: ReauthorizePhase }>): ReactNode {
  const { old, target } = observation;
  switch (phase.kind) {
    case "awaiting-authorization": {
      const { order } = phase;
      switch (order.kind) {
        case "authorize-first":
          return `Authorize ${old.displayName}'s provider account again. The old connection stays until its grants and pins have moved.`;
        case "revoke-first":
          return `${old.displayName} is not active, so its tools are already denied. The provider links an account to one connection at a time, so revoke it first, then authorize the same account.`;
        case "choose":
          return `${old.displayName} is active. If you authorize the same provider account, the old connection must be revoked first, and its tools stop working until this page re-pins them.`;
        case "wait":
          return (
            <>
              {old.displayName} changed moments ago and the platform may be refreshing its token.
              Check again after <Timestamp value={order.until} />.
            </>
          );
        default: {
          const unexpected: never = order;
          return unexpected;
        }
      }
    }
    case "authorization-failed":
      return (
        <>
          <p>{FAILURE_COPY[phase.error]}</p>
          {phase.collisionPossible ? (
            <p>
              The provider may have refused because {old.displayName} still holds the same account.
              Revoke it first, then authorize again.
            </p>
          ) : null}
        </>
      );
    case "revoking-old": {
      const account = target ? accountOf(target) : undefined;
      return `Grants and pins now use ${target?.displayName ?? "the new connection"}${account ? ` (${account})` : ""}. Revoke ${old.displayName} to finish.`;
    }
    default: {
      const unexpected: never = phase;
      return unexpected;
    }
  }
}

/**
 * The connection the provider callback named, which grants and pins move to. A link can name any
 * connection in the environment, so the page shows it and the operator confirms it before
 * Continue moves anything.
 */
export function ReauthorizeTarget({
  confirmed,
  old,
  onConfirm,
  target,
}: Readonly<{
  confirmed: boolean;
  old: ConnectionView;
  /** Absent once nothing is left for Continue to move. */
  onConfirm: ((confirmed: boolean) => void) | undefined;
  target: ConnectionView;
}>) {
  const account = accountOf(target);
  return (
    <section className="flex flex-col gap-4">
      <Subheading>New connection</Subheading>
      <DescriptionList>
        <DescriptionTerm>Name</DescriptionTerm>
        <DescriptionDetails>{target.displayName}</DescriptionDetails>
        <DescriptionTerm>External account</DescriptionTerm>
        <DescriptionDetails>{account ?? "Not known until verified"}</DescriptionDetails>
        <DescriptionTerm>Created</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={target.createdAt} />
        </DescriptionDetails>
        <DescriptionTerm>ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={target.id} />
        </DescriptionDetails>
      </DescriptionList>
      {onConfirm ? (
        <CheckboxField>
          <Checkbox checked={confirmed} onCheckedChange={onConfirm} />
          <Label>
            Move the grants and pins of {old.displayName} to {target.displayName}
            {account ? ` (${account})` : ""}
          </Label>
          <Description>
            Confirm that this is the connection you just authorized. Continue verifies it, creates
            the grants on it, and re-pins deployments to them.
          </Description>
        </CheckboxField>
      ) : null}
    </section>
  );
}

/**
 * Starts the provider authorization of a reauthorization and finally revokes the old connection.
 * When the provider would refuse the account while the old connection holds it, the page starts
 * the authorization first, so a refusal revokes nothing, then revokes, then opens the consent page.
 */
export function ReauthorizeControls({
  observation,
  phase,
  scope,
  search,
}: Readonly<{
  observation: RebindObservation;
  phase: ReauthorizePhase;
  scope: EnvironmentScope;
  search: ReauthorizeSearch;
}>) {
  const { old } = observation;
  const queryClient = useQueryClient();
  const catalog = useQuery(providerCatalogQuery());
  const apps = useQuery(oauthAppsQuery(scope));
  const [resource, setResource] = useState("");
  const [account, setAccount] = useState("");
  const [pickedAppId, setPickedAppId] = useState<string | undefined>(old.providerApplicationId);
  const [revoking, setRevoking] = useState(false);
  const [consentUrl, setConsentUrl] = useState<string>();
  const [leaving, setLeaving] = useState(false);
  const entry = catalog.data?.find((provider) => provider.key === old.providerKey);
  const oauth = entry?.access === "oauth" ? entry.oauth : undefined;
  const choice =
    oauth && apps.data
      ? appChoice(
          apps.data.apps,
          { key: old.providerKey, requiresApp: oauth.requiresApp },
          pickedAppId,
        )
      : undefined;
  const requestedResource = resource.trim();
  const {
    error: _error,
    kind: _kind,
    since: _since,
    target: _target,
    verification: _verification,
    ...selections
  } = search;
  const begin = useMutation({
    mutationFn: (from: string) =>
      beginAuthorizationFn({
        data: {
          body: {
            providerKey: old.providerKey,
            ...(choice?.kind === "chosen" ? { providerApplicationId: choice.app.id } : {}),
            ...(entry?.resource ? { requestedResource } : {}),
          },
          idempotencyKey: crypto.randomUUID(),
          scope,
          target: { kind: "rebind", oldConnectionId: old.id, since: from, ...selections },
        },
      }),
  });
  if (begin.error instanceof UnauthenticatedError) throw begin.error;
  const problem = begin.error
    ? describeProblem(begin.error, "Authorization did not start")
    : undefined;
  const leave = (url: string) => {
    setLeaving(true);
    window.location.assign(url);
  };
  const ready =
    catalog.isSuccess &&
    (choice?.kind === "chosen" || choice?.kind === "platform") &&
    (!entry?.resource || requestedResource.length > 0);
  const busy = begin.isPending || leaving;
  const order = phase.kind === "awaiting-authorization" ? phase.order : undefined;
  const since = phase.kind === "revoking-old" ? undefined : phase.since;
  const revokeFirst =
    order?.kind === "revoke-first" ||
    (order?.kind === "choose" && account === "same") ||
    (phase.kind === "authorization-failed" && phase.collisionPossible);
  const authorizeFirst =
    order?.kind === "authorize-first" ||
    (order?.kind === "choose" && account === "different") ||
    phase.kind === "authorization-failed";
  const revokeStep = phase.kind === "revoking-old" ? phase.next : revokeOldStep(old, undefined);
  const authorize = (from: string) =>
    begin.mutate(from, { onSuccess: ({ authorizationUrl }) => leave(authorizationUrl) });
  const revokeThenAuthorize = (from: string) =>
    begin.mutate(from, {
      onSuccess: ({ authorizationUrl }) => {
        setConsentUrl(authorizationUrl);
        setRevoking(true);
      },
    });

  return (
    <div className="flex flex-col gap-4">
      {phase.kind === "revoking-old" ? null : <Text>{CONSENT_NOTICE}</Text>}
      {order?.kind === "choose" ? (
        <RadioGroup aria-label="Account to authorize" onValueChange={setAccount} value={account}>
          <RadioField>
            <RadioGroupItem value="same" />
            <Label>
              The same account
              {accountOf(old) ? ` (${accountOf(old)})` : ""}
            </Label>
            <Description>
              Revokes {old.displayName} first. Its tools stay denied from the revoke until this page
              re-pins them, including the time you spend on the provider's consent page.
            </Description>
          </RadioField>
          <RadioField>
            <RadioGroupItem value="different" />
            <Label>A different account</Label>
            <Description>
              Keeps {old.displayName} working until the new connection's grants and pins are in
              place.
            </Description>
          </RadioField>
        </RadioGroup>
      ) : null}
      {phase.kind === "revoking-old" ? null : (
        <OAuthAppPicker
          choice={choice}
          error={apps.error}
          onPick={setPickedAppId}
          providerName={entry?.displayName ?? old.providerKey}
          scope={scope}
        />
      )}
      {entry?.resource && phase.kind !== "revoking-old" ? (
        <TenantField onChange={setResource} resource={entry.resource} value={resource} />
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {phase.kind === "revoking-old" ? (
          <Button onClick={() => setRevoking(true)}>Revoke {old.displayName}</Button>
        ) : null}
        {authorizeFirst && since ? (
          <Button disabled={!ready || busy} onClick={() => authorize(since)}>
            {busy
              ? "Opening the provider…"
              : phase.kind === "authorization-failed"
                ? "Authorize again"
                : "Authorize"}
          </Button>
        ) : null}
        {revokeFirst && since && authorizeFirst ? (
          <Button
            disabled={!ready || busy}
            onClick={() => revokeThenAuthorize(since)}
            variant="outline"
          >
            Revoke and authorize
          </Button>
        ) : null}
        {revokeFirst && since && !authorizeFirst ? (
          <Button
            variant="destructive"
            disabled={!ready || busy}
            onClick={() => revokeThenAuthorize(since)}
          >
            Revoke and authorize
          </Button>
        ) : null}
        {order?.kind === "wait" ? (
          <Button
            onClick={() =>
              void queryClient.invalidateQueries({
                queryKey: rebindObservationQuery(scope, old.id, search).queryKey,
              })
            }
            variant="outline"
          >
            Check again
          </Button>
        ) : null}
      </div>
      {problem ? (
        <Callout variant="destructive">
          <CalloutTitle>{problem.title}</CalloutTitle>
          <CalloutDescription>
            {problem.description ? <p>{problem.description}</p> : null}
            <ProblemReference requestId={problem.requestId} status={problem.status} />
          </CalloutDescription>
        </Callout>
      ) : null}
      <RevokeConnectionDialog
        confirmLabel={phase.kind === "revoking-old" ? "Revoke connection" : "Revoke and authorize"}
        connection={old}
        deployments={observation.deployments}
        grants={observation.grants}
        idempotencyKey={revokeStep.key}
        onClose={() => {
          setRevoking(false);
          setConsentUrl(undefined);
        }}
        onRevoked={() => {
          if (consentUrl) leave(consentUrl);
        }}
        onSubmit={rereadOnConflict(
          queryClient,
          rebindObservationQuery(scope, old.id, search).queryKey,
        )}
        open={revoking}
        scope={scope}
      />
    </div>
  );
}
