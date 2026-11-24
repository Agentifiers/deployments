import {
  OPERATOR_ACCESS_DEFAULT_MINUTES,
  OPERATOR_ACCESS_MAXIMUM_MINUTES,
} from "@deployments-ai/api-contract/system";
import { useQueryClient, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  closeOrganizationAccessFn,
  openOrganizationAccessFn,
} from "../../data/system-mutations.ts";
import { invalidateOperatorAccess, systemOperatorAccessQuery } from "../../data/system-queries.ts";
import type { SystemOrganizationAccess } from "../../server/system-data.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Description, ErrorMessage, Field, Label } from "@/components/ui/field";
import { Subheading } from "@/components/ui/heading";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Code, Text, TextLink } from "@/components/ui/text";
import { ActionDialog } from "../action-dialog.tsx";
import { LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";

type Access = NonNullable<SystemOrganizationAccess["access"]>;

export interface AccessDraft {
  readonly duration: string;
  readonly reason: string;
  readonly ticket: string;
}

export function accessProblems(draft: AccessDraft) {
  const minutes = Number(draft.duration);
  return {
    duration:
      Number.isInteger(minutes) && minutes >= 1 && minutes <= OPERATOR_ACCESS_MAXIMUM_MINUTES
        ? undefined
        : `Whole minutes from 1 to ${OPERATOR_ACCESS_MAXIMUM_MINUTES}`,
    reason:
      draft.reason.trim() === ""
        ? "Required"
        : draft.reason.length > 500
          ? "At most 500 characters"
          : undefined,
    ticket: draft.ticket.length > 200 ? "At most 200 characters" : undefined,
  };
}

/** Whether the viewer may open the organization's own pages: only while access is open. */
export const accessIsOpen = (access: SystemOrganizationAccess["access"]): access is Access =>
  access?.status === "open";

export function OpenAccessDialog({
  onClose,
  organization,
  renewing,
}: Readonly<{
  onClose: () => void;
  organization: SystemOrganizationAccess["organization"];
  renewing: boolean;
}>) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AccessDraft>({
    duration: String(OPERATOR_ACCESS_DEFAULT_MINUTES),
    reason: "",
    ticket: "",
  });
  const problems = accessProblems(draft);
  const ticket = draft.ticket.trim();
  return (
    <ActionDialog
      confirmLabel={renewing ? "Renew access" : "Open access"}
      description={`Lets you read and change ${organization.name}'s data as a platform administrator until access expires or you close it. Its members see who opened access, when, and why in their audit log, and every change you make there names your access.`}
      invalid={Object.values(problems).some((problem) => problem !== undefined)}
      onClose={onClose}
      onSuccess={() => void invalidateOperatorAccess(queryClient, organization.id)}
      open
      runOnce={() =>
        openOrganizationAccessFn({
          data: {
            body: {
              durationMinutes: Number(draft.duration),
              reason: draft.reason.trim(),
              ...(ticket === "" ? {} : { ticket }),
            },
            organizationId: organization.id,
          },
        })
      }
      size="xl"
      successMessage={(result) => (result.renewed ? "Access renewed" : "Access opened")}
      title={renewing ? "Renew operator access" : "Open operator access"}
    >
      <Field>
        <Label>Reason</Label>
        <Textarea
          name="reason"
          onChange={(event) => setDraft({ ...draft, reason: event.target.value })}
          rows={2}
          value={draft.reason}
        />
        <Description>Shown to the organization in its audit log.</Description>
        {draft.reason !== "" && problems.reason ? (
          <ErrorMessage>{problems.reason}</ErrorMessage>
        ) : null}
      </Field>
      <Field>
        <Label>Ticket (optional)</Label>
        <Input
          autoComplete="off"
          name="ticket"
          onChange={(event) => setDraft({ ...draft, ticket: event.target.value })}
          placeholder="SUP-1234"
          value={draft.ticket}
        />
        {problems.ticket ? <ErrorMessage>{problems.ticket}</ErrorMessage> : null}
      </Field>
      <Field>
        <Label>Duration in minutes</Label>
        <Input
          inputMode="numeric"
          name="duration"
          onChange={(event) => setDraft({ ...draft, duration: event.target.value })}
          value={draft.duration}
        />
        <Description>
          At most {OPERATOR_ACCESS_MAXIMUM_MINUTES / 60} hours; renew to extend.
        </Description>
        {problems.duration ? <ErrorMessage>{problems.duration}</ErrorMessage> : null}
      </Field>
    </ActionDialog>
  );
}

function CloseAccessDialog({
  onClose,
  organization,
}: Readonly<{ onClose: () => void; organization: SystemOrganizationAccess["organization"] }>) {
  const queryClient = useQueryClient();
  return (
    <ActionDialog
      confirmLabel="Close access"
      description="You lose access to the organization's data at once. The close is recorded in its audit log."
      onClose={onClose}
      onSuccess={() => void invalidateOperatorAccess(queryClient, organization.id)}
      open
      runOnce={() => closeOrganizationAccessFn({ data: { organizationId: organization.id } })}
      successMessage={(result) =>
        result.changed ? "Access closed" : { neutral: "No access was open" }
      }
      title="Close operator access"
    />
  );
}

const STATUS_COLOR = { closed: "zinc", expired: "zinc", open: "amber" } as const;

/** The viewer's operator access to one organization, with open, renew, and close. */
export function OperatorAccessPanel({ access, organization }: Readonly<SystemOrganizationAccess>) {
  const [dialog, setDialog] = useState<"close" | "open">();
  const open = accessIsOpen(access);
  const archived = organization.status === "archived";
  return (
    <section aria-label="Operator access" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Subheading>Operator access</Subheading>
        <Badge color={access ? STATUS_COLOR[access.status] : "zinc"}>
          {access?.status ?? "never opened"}
        </Badge>
        <div className="ml-auto flex gap-2">
          <Button disabled={archived} onClick={() => setDialog("open")} variant="outline">
            {open ? "Renew…" : "Open access…"}
          </Button>
          {open ? (
            <Button onClick={() => setDialog("close")} variant="outline">
              Close access…
            </Button>
          ) : null}
        </div>
      </div>
      {open ? (
        <Text>
          Open until <Timestamp value={access.expiresAt} /> for “{access.reason}”
          {access.ticket ? (
            <>
              {" "}
              (<Code>{access.ticket}</Code>)
            </>
          ) : null}
          .
        </Text>
      ) : (
        <Text>
          {archived
            ? "The organization is archived, so operator access cannot be opened."
            : "Open access to see its members and open the organization. Standing and spend need no access."}
        </Text>
      )}
      {dialog === "open" ? (
        <OpenAccessDialog
          onClose={() => setDialog(undefined)}
          organization={organization}
          renewing={open}
        />
      ) : null}
      {dialog === "close" ? (
        <CloseAccessDialog onClose={() => setDialog(undefined)} organization={organization} />
      ) : null}
    </section>
  );
}

/** Every open operator access in the install, for oversight. */
export function OperatorAccessList() {
  const pagesQuery = systemOperatorAccessQuery();
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const grants = data.pages.flatMap((page) => page.items);
  return (
    <div className="flex flex-col gap-4">
      {grants.length === 0 ? (
        <Text>No platform administrator has operator access open.</Text>
      ) : (
        <Table dense striped>
          <TableHeader>
            <TableRow>
              <TableHead>Organization</TableHead>
              <TableHead>Administrator</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Opened</TableHead>
              <TableHead>Expires</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grants.map((grant) => (
              <TableRow key={grant.grantId}>
                <TableCell>
                  <TextLink href={`/system/organizations/${grant.organizationId}`}>
                    <PublicId value={grant.organizationId} />
                  </TextLink>
                </TableCell>
                <TableCell>
                  <PublicId value={grant.principalId} />
                </TableCell>
                <TableCell>
                  {grant.reason}
                  {grant.ticket ? (
                    <>
                      {" "}
                      <Code>{grant.ticket}</Code>
                    </>
                  ) : null}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={grant.openedAt} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={grant.expiresAt} />
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
