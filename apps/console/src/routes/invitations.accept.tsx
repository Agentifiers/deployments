import { createFileRoute, useLocation, type ErrorComponentProps } from "@tanstack/react-router";
import { ConsoleError } from "../components/console-states.tsx";
import {
  AcceptInvitation,
  InvitationSignIn,
} from "../components/invitations/accept-invitation.tsx";
import { organizationsQuery, sessionIdentityQuery } from "../data/console-queries.ts";
import { UnauthenticatedError } from "../errors.ts";
import { invitationLink, invitationSearch, type InvitationSearch } from "../invitations/accept.ts";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/invitations/accept")({
  validateSearch: (search): InvitationSearch => invitationSearch(search),
  loaderDeps: ({ search }) => ({ needsSession: invitationLink(search) !== undefined }),
  loader: ({ context, deps }) =>
    deps.needsSession
      ? Promise.all([
          context.queryClient.ensureQueryData(sessionIdentityQuery()),
          context.queryClient.ensureQueryData(organizationsQuery()),
        ])
      : undefined,
  // The token is in the query string. `strict-origin` keeps it out of Referer headers while
  // `Origin` still names the console, which the same-origin sign-out post requires.
  head: () => ({ meta: [{ content: "strict-origin", name: "referrer" }] }),
  component: AcceptInvitationPage,
  errorComponent: AcceptInvitationError,
});

function AcceptInvitationPage() {
  return <AcceptInvitation link={invitationLink(Route.useSearch())} />;
}

function AcceptInvitationError(props: ErrorComponentProps) {
  const search = useLocation({ select: (location) => location.search });
  const link = invitationLink(invitationSearch(search));
  if (props.error instanceof UnauthenticatedError && link !== undefined) {
    return <InvitationSignIn link={link} />;
  }
  return <ConsoleError {...props} />;
}
