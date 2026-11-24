import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { AddConnectionDialog } from "../components/connections/credential-dialogs.tsx";
import { parseConnectReturn, type OAuthCallbackError } from "../connections/oauth.ts";
import { reauthorizeReturn } from "../connections/rebind.ts";
import { organizationShellQuery } from "../data/console-queries.ts";
import { environmentPath, type EnvironmentScope } from "../scope.ts";
import { Button } from "@/components/ui/button";
import { Callout, CalloutAction, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { TextLink } from "@/components/ui/text";

const FAILURE_COPY: Readonly<
  Record<OAuthCallbackError, { readonly description: string; readonly title: string }>
> = {
  access_denied: {
    description: "The provider's consent page was declined, so no connection was created.",
    title: "Authorization declined",
  },
  authorization_failed: {
    description:
      "The platform could not finish the authorization. A provider account that is already connected in this environment cannot be connected twice; reauthorize that connection instead.",
    title: "Authorization failed",
  },
};

/**
 * Where the provider callback returns the browser. Only this route reads the callback's
 * parameters: a reauthorization continues on its rebind page, and a new connection opens.
 */
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/connections/authorized")({
  validateSearch: (search: Readonly<Record<string, unknown>>) => search,
  beforeLoad: ({ params, search }) => {
    const reauthorization = reauthorizeReturn(search);
    if (reauthorization) {
      throw redirect({
        params: { ...params, connectionId: reauthorization.oldConnectionId },
        replace: true,
        search: reauthorization.search,
        to: "/o/$orgId/p/$projectId/e/$envId/connections/$connectionId/rebind",
      });
    }
    const { result } = parseConnectReturn(search);
    if (result.kind === "connected") {
      throw redirect({
        params: { ...params, connectionId: result.connectionId },
        replace: true,
        to: "/o/$orgId/p/$projectId/e/$envId/connections/$connectionId",
      });
    }
    if (result.kind === "none") {
      throw redirect({ params, replace: true, to: "/o/$orgId/p/$projectId/e/$envId/connections" });
    }
  },
  component: Authorized,
});

function Authorized() {
  const { envId, orgId, projectId } = Route.useParams();
  const { result } = parseConnectReturn(Route.useSearch());
  const { data: shell } = useSuspenseQuery(organizationShellQuery(orgId));
  const [adding, setAdding] = useState(false);
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const copy = FAILURE_COPY[result.kind === "failed" ? result.error : "authorization_failed"];
  const { access } = shell;
  return (
    <>
      <Callout variant="destructive">
        <CalloutTitle>{copy.title}</CalloutTitle>
        <CalloutDescription>{copy.description}</CalloutDescription>
        <CalloutAction>
          {access.createProviderCredential && access.beginProviderAuthorization ? (
            <Button onClick={() => setAdding(true)} variant="outline">
              Try again
            </Button>
          ) : (
            <TextLink href={`${environmentPath(scope)}/connections`}>Back to connections</TextLink>
          )}
        </CalloutAction>
      </Callout>
      {access.createProviderCredential ? (
        <AddConnectionDialog
          canAuthorize={access.beginProviderAuthorization}
          onClose={() => setAdding(false)}
          open={adding}
          scope={scope}
        />
      ) : null}
    </>
  );
}
