import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { systemPersonQuery, systemSecurityEventsQuery } from "../../data/system-queries.ts";
import type { SystemPerson, SystemSecurityEvent } from "../../server/system-data.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading, Subheading } from "@/components/ui/heading";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code, Text, TextLink } from "@/components/ui/text";
import { BackLink } from "../back-link.tsx";
import { LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { RevokeSessionsDialog } from "./person-dialogs.tsx";
import { PrincipalStatusDialog, type PrincipalStatus } from "./principal-status.tsx";
import { StatusBadge } from "@/components/status-badge";

type SignIn = NonNullable<SystemPerson["signIn"]>;

function mfaText(mfa: SignIn["mfa"]) {
  switch (mfa.state) {
    case "none":
      return "Not enrolled";
    case "pending":
      return "Enrollment started, not confirmed";
    case "active":
      return `Enrolled, ${mfa.recoveryCodesRemaining} recovery codes left`;
    case "disabled":
      return "Turned off";
  }
}

function sessionsText(sessions: SignIn["sessions"]) {
  const more = sessions.capped ? " or more" : "";
  return `${sessions.browser}${more} browser, ${sessions.refreshTokenFamilies}${more} refresh token`;
}

function actorText(actor: SystemSecurityEvent["actor"], principalId: string) {
  if (!actor) return "system";
  if (actor.id === principalId) return "the person";
  return actor.id ? `${actor.type} …${actor.id.slice(-8)}` : actor.type;
}

function SignInState({ signIn }: Readonly<{ signIn: SystemPerson["signIn"] }>) {
  if (!signIn) {
    return (
      <>
        <DescriptionTerm>Sign-in</DescriptionTerm>
        <DescriptionDetails>Managed by the install's identity provider</DescriptionDetails>
      </>
    );
  }
  return (
    <>
      <DescriptionTerm>Email verified</DescriptionTerm>
      <DescriptionDetails>
        {signIn.emailVerifiedAt ? <Timestamp value={signIn.emailVerifiedAt} /> : "Not verified"}
      </DescriptionDetails>
      <DescriptionTerm>Multi-factor</DescriptionTerm>
      <DescriptionDetails>{mfaText(signIn.mfa)}</DescriptionDetails>
      <DescriptionTerm>Active sessions</DescriptionTerm>
      <DescriptionDetails>{sessionsText(signIn.sessions)}</DescriptionDetails>
    </>
  );
}

function Organizations({
  organizations,
}: Readonly<{ organizations: SystemPerson["organizations"] }>) {
  if (organizations.items.length === 0) return <Text>The person belongs to no organization.</Text>;
  return (
    <div className="flex flex-col gap-2">
      <Table dense striped>
        <TableHeader>
          <TableRow>
            <TableHead>Organization</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Membership</TableHead>
            <TableHead>Joined</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {organizations.items.map((item) => (
            <TableRow key={item.organizationId}>
              <TableCell>
                <TextLink href={`/system/organizations/${item.organizationId}`}>
                  {item.name ?? item.organizationId}
                </TextLink>
                {item.organizationStatus && item.organizationStatus !== "active" ? (
                  <StatusBadge className="ml-2" status={item.organizationStatus} />
                ) : null}
              </TableCell>
              <TableCell>{item.role}</TableCell>
              <TableCell>
                <StatusBadge status={item.status} />
              </TableCell>
              <TableCell>{item.joinedAt ? <Timestamp value={item.joinedAt} /> : "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {organizations.capped ? (
        <Text>
          Showing the first {organizations.items.length} memberships; the person has more.
        </Text>
      ) : null}
    </div>
  );
}

/** The person's security events, newest first. Withheld fields are named, never shown. */
export function SecurityEvents({ principalId }: Readonly<{ principalId: string }>) {
  const pagesQuery = systemSecurityEventsQuery(principalId);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const events = data.pages.flatMap((page) => page.items);
  return (
    <div className="flex flex-col gap-4">
      {events.length === 0 ? (
        <Text>No security events yet.</Text>
      ) : (
        <Table dense striped>
          <TableHeader>
            <TableRow>
              <TableHead>Event</TableHead>
              <TableHead>When</TableHead>
              <TableHead>By</TableHead>
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((event) => (
              <TableRow key={event.id}>
                <TableCell>
                  <Code>{event.eventType}</Code>
                </TableCell>
                <TableCell>
                  <Timestamp value={event.occurredAt} />
                </TableCell>
                <TableCell>{actorText(event.actor, principalId)}</TableCell>
                <TableCell className="text-xs">
                  {Object.entries(event.details)
                    .map(([field, value]) => `${field}: ${String(value)}`)
                    .join(" · ")}
                  {event.withheldFields.length > 0 ? (
                    <div className="text-muted-foreground">
                      Withheld: {event.withheldFields.join(", ")}
                    </div>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <LoadMore
        error={error}
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        queryKey={pagesQuery.queryKey}
      />
    </div>
  );
}

type PersonDialog =
  | { readonly kind: "status"; readonly status: PrincipalStatus }
  | { readonly kind: "revoke" };

/** Who the person is, where they belong, how they sign in, and what an operator can do. */
export function PersonDetail({
  principalId,
  selfPrincipalId,
}: Readonly<{ principalId: string; selfPrincipalId: string | undefined }>) {
  const { data: person } = useSuspenseQuery(systemPersonQuery(principalId));
  const [dialog, setDialog] = useState<PersonDialog>();
  const close = () => setDialog(undefined);
  const self = principalId === selfPrincipalId;
  const managed = person.signIn !== null;
  return (
    <div className="flex flex-col gap-10">
      <div className="space-y-2">
        <BackLink href="/system/people" label="People" />
        <div className="flex flex-wrap items-center gap-3">
          <Heading>{person.displayName ?? person.primaryEmail ?? person.id}</Heading>
          <StatusBadge status={person.status} />
          {person.platformRole ? <Badge color="blue">{person.platformRole}</Badge> : null}
        </div>
        <Text>
          <Code>{person.id}</Code> · {person.kind}
        </Text>
      </div>
      <DescriptionList>
        <DescriptionTerm>Email</DescriptionTerm>
        <DescriptionDetails>{person.primaryEmail ?? "—"}</DescriptionDetails>
        <SignInState signIn={person.signIn} />
        <DescriptionTerm>Created</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={person.createdAt} />
        </DescriptionDetails>
        <DescriptionTerm>Updated</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={person.updatedAt} />
        </DescriptionDetails>
      </DescriptionList>
      <section className="flex flex-col gap-4">
        <Subheading>Actions</Subheading>
        <div className="flex flex-wrap gap-2">
          {person.status === "disabled" ? (
            <Button
              disabled={self || !managed}
              onClick={() => setDialog({ kind: "status", status: "active" })}
              variant="outline"
            >
              Enable…
            </Button>
          ) : (
            <Button
              disabled={self || !managed}
              onClick={() => setDialog({ kind: "status", status: "disabled" })}
              variant="destructive"
            >
              Disable…
            </Button>
          )}
          <Button
            disabled={!managed}
            onClick={() => setDialog({ kind: "revoke" })}
            variant="outline"
          >
            End sessions…
          </Button>
        </div>
        {self ? (
          <Text>You cannot change your own status. Ending your own sessions signs you out.</Text>
        ) : null}
        {managed ? null : (
          <Text>
            The install's identity provider manages this person's sign-in, so these actions are off.
          </Text>
        )}
      </section>
      <section className="flex flex-col gap-4">
        <Subheading>Organizations</Subheading>
        <Organizations organizations={person.organizations} />
      </section>
      <section className="flex flex-col gap-4">
        <Subheading>Security events</Subheading>
        <SecurityEvents principalId={principalId} />
      </section>
      {dialog?.kind === "status" ? (
        <PrincipalStatusDialog onClose={close} principalId={principalId} status={dialog.status} />
      ) : null}
      {dialog?.kind === "revoke" ? (
        <RevokeSessionsDialog onClose={close} principalId={principalId} />
      ) : null}
    </div>
  );
}
