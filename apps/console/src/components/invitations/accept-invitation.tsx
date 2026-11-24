import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef, type ReactNode } from "react";
import {
  invalidateTenancy,
  organizationsQuery,
  sessionIdentityQuery,
} from "../../data/console-queries.ts";
import { acceptInvitationFn } from "../../data/membership-mutations.ts";
import { PlatformApiError, UnauthenticatedError } from "../../errors.ts";
import {
  acceptFailurePhase,
  acceptRecovery,
  invitationPath,
  mayHaveJoined,
  type AcceptPhase,
  type InvitationLink,
} from "../../invitations/accept.ts";
import { Button } from "@/components/ui/button";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading } from "@/components/ui/heading";
import { toast } from "@/components/ui/sonner";
import { Text } from "@/components/ui/text";
import { StatePanel } from "../console-states.tsx";
import { PublicId } from "../public-id.tsx";
import { describeProblem, ProblemReference } from "../section-boundary.tsx";
import { SignOutButton, SwitchAccountButton } from "../sign-out.tsx";

interface AcceptControls {
  readonly accept: () => void;
  readonly pending: boolean;
  /** Clears the failure, back to `ready`. */
  readonly retry: () => void;
  readonly returnTo: string;
}

interface PhaseView {
  readonly actions: (controls: AcceptControls) => ReactNode;
  /** `reason` is the API's explanation of a failed accept; only failure phases have one. */
  readonly description: (reason: string | undefined) => ReactNode;
  readonly title: string;
}

const chooseOrganization = <Button href="/">Choose an organization</Button>;

// `satisfies` keeps each entry's own signature, so the malformed page, which has no link and
// therefore no controls, can render its entry.
const PHASE_VIEWS = {
  "already-member": {
    actions: () => chooseOrganization,
    description: () =>
      "This account already belongs to the organization that sent this invitation.",
    title: "You are already a member",
  },
  expired: {
    actions: () => chooseOrganization,
    description: () => "Ask the person who invited you to send a new invitation.",
    title: "This invitation has expired",
  },
  invalid: {
    actions: () => chooseOrganization,
    description: () =>
      "The invitation does not exist or this link does not match it. Open the link again from your email, or ask the person who invited you for a new invitation.",
    title: "This invitation link is not valid",
  },
  malformed: {
    actions: () => chooseOrganization,
    description: () =>
      "Part of this link is missing or damaged. Open the invitation link again from your email.",
    title: "This invitation link is incomplete",
  },
  ready: {
    actions: ({ accept, pending, returnTo }) => (
      <>
        <Button disabled={pending} onClick={accept}>
          {pending ? "Accepting…" : "Accept invitation"}
        </Button>
        <SwitchAccountButton returnTo={returnTo} />
        <SignOutButton />
      </>
    ),
    description: () => "Accepting adds the signed-in account to the organization that invited you.",
    title: "Accept your invitation",
  },
  rejected: {
    actions: ({ retry }) => <Button onClick={retry}>Try again</Button>,
    description: (reason) => reason,
    title: "The invitation was not accepted",
  },
  uncertain: {
    actions: ({ retry }) => (
      <>
        <Button href="/">Check my organizations</Button>
        <Button onClick={retry} variant="outline">
          Try again
        </Button>
      </>
    ),
    description: () =>
      "The response did not arrive, so the invitation may already be accepted. Check your organizations before you try again.",
    title: "The platform may have applied this",
  },
  unavailable: {
    actions: () => chooseOrganization,
    description: () =>
      "This invitation was already accepted, revoked, or expired earlier. If you still need access, ask the person who invited you for a new invitation.",
    title: "Already used or revoked",
  },
  "wrong-account": {
    actions: ({ returnTo }) => (
      <>
        <SwitchAccountButton returnTo={returnTo} />
        <SignOutButton />
      </>
    ),
    description: () =>
      "The email address of the signed-in account does not match the address this invitation was sent to. Sign in with that address to accept.",
    title: "This invitation is for another account",
  },
} satisfies Readonly<Record<AcceptPhase["kind"], PhaseView>>;

function PhasePanel({
  actions,
  children,
  description,
  title,
}: Readonly<{ actions: ReactNode; children?: ReactNode; description: ReactNode; title: string }>) {
  return (
    <StatePanel>
      <Heading>{title}</Heading>
      <Text>{description}</Text>
      {children}
      <div className="flex flex-wrap items-center gap-3">{actions}</div>
    </StatePanel>
  );
}

function problemOf(error: unknown) {
  return error instanceof PlatformApiError ? error.problem : undefined;
}

function AcceptLink({ link }: Readonly<{ link: InvitationLink }>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: identity } = useSuspenseQuery(sessionIdentityQuery());
  const { data: organizations } = useSuspenseQuery(organizationsQuery());
  // Retries diff against the list from before the first attempt, which may have committed.
  const organizationsBefore = useRef<typeof organizations>(undefined);
  const earlierAnswerLost = useRef(false);
  const mutation = useMutation({
    mutationFn: async (before: typeof organizations) => {
      try {
        return await acceptInvitationFn({ data: link });
      } catch (error) {
        if (error instanceof UnauthenticatedError) throw error;
        const phase = acceptFailurePhase(problemOf(error));
        const recover = mayHaveJoined(phase, { earlierAnswerLost: earlierAnswerLost.current });
        earlierAnswerLost.current ||= phase.kind === "uncertain";
        if (!recover) throw error;
        const after = await queryClient
          .fetchQuery({ ...organizationsQuery(), staleTime: 0 })
          .catch(() => undefined);
        const recovery = after === undefined ? undefined : acceptRecovery(before, after);
        if (recovery?.kind !== "joined") throw error;
        toast.success(`You joined ${recovery.organization.name}`);
        return { organizationId: recovery.organization.id };
      }
    },
    // A lost response may still have added the membership; "Check my organizations" must refetch.
    onError: () => void invalidateTenancy(queryClient),
    onSuccess: async ({ organizationId }) => {
      await invalidateTenancy(queryClient);
      // Replaces only this entry; an entry left from before a sign-in still holds the token URL.
      await navigate({ params: { orgId: organizationId }, replace: true, to: "/o/$orgId" });
    },
  });
  const { error } = mutation;
  if (error instanceof UnauthenticatedError) throw error;
  const phase: AcceptPhase = error ? acceptFailurePhase(problemOf(error)) : { kind: "ready" };
  const problem = error ? describeProblem(error, "The invitation was not accepted") : undefined;
  const view = PHASE_VIEWS[phase.kind];
  return (
    <PhasePanel
      actions={view.actions({
        accept: () => {
          organizationsBefore.current ??= organizations;
          mutation.mutate(organizationsBefore.current);
        },
        pending: mutation.isPending,
        retry: mutation.reset,
        returnTo: invitationPath(link),
      })}
      description={view.description(problem?.description ?? problem?.title)}
      title={view.title}
    >
      <DescriptionList>
        <DescriptionTerm>Signed in as</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={identity.principalId} />
        </DescriptionDetails>
        <DescriptionTerm>Invitation</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={link.invitationId} />
        </DescriptionDetails>
      </DescriptionList>
      {problem ? <ProblemReference requestId={problem.requestId} status={problem.status} /> : null}
    </PhasePanel>
  );
}

/** The emailed invitation link's page. A link that does not parse never asks for a session. */
export function AcceptInvitation({ link }: Readonly<{ link: InvitationLink | undefined }>) {
  if (link !== undefined) return <AcceptLink link={link} />;
  const { actions, description, title } = PHASE_VIEWS.malformed;
  return <PhasePanel actions={actions()} description={description()} title={title} />;
}

/** Shown instead of the page when a valid link has no session; sign-in returns to the link. */
export function InvitationSignIn({ link }: Readonly<{ link: InvitationLink }>) {
  return (
    <StatePanel>
      <Heading>Sign in to accept your invitation</Heading>
      <Text>
        Sign in with the email address the invitation was sent to. No account? Use Create account on
        the sign-in page if it is offered; otherwise ask the person who invited you or your install
        operator to create one, then open this link again.
      </Text>
      {/* A document navigation: `/auth/login` is a server route, not a client page. */}
      <form action="/auth/login" method="get">
        <input name="returnTo" type="hidden" value={invitationPath(link)} />
        <Button type="submit">Sign in</Button>
      </form>
    </StatePanel>
  );
}
