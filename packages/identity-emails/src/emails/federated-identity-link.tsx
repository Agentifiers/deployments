import { Button, Heading, Text } from "react-email";
import { expiryFormat, IdentityEmailLayout } from "./layout.tsx";

export interface FederatedIdentityLinkProps {
  readonly actionUrl: string;
  readonly expiresAt: string;
  readonly identityProvider: { readonly displayName: string; readonly issuer: string };
  readonly organizationName: string;
}

/** An http(s) issuer reads best as its host; a SAML entity ID such as a URN is shown whole. */
function issuerLabel(issuer: string) {
  const url = URL.parse(issuer);
  return url?.protocol === "https:" || url?.protocol === "http:" ? url.host : issuer;
}

export function FederatedIdentityLink({
  actionUrl,
  expiresAt,
  identityProvider,
  organizationName,
}: FederatedIdentityLinkProps) {
  return (
    <IdentityEmailLayout preview={`Confirm your ${organizationName} sign-in connection`}>
      <Heading as="h1" className="mb-4 text-2xl font-semibold text-ink">
        Confirm your sign-in connection
      </Heading>
      <Text className="text-base leading-6 text-ink">
        Someone signed in through {identityProvider.displayName} (
        {issuerLabel(identityProvider.issuer)}), the identity provider for {organizationName}, using
        your email address. Confirming lets that identity provider account sign in to your
        Deployments.ai account.
      </Text>
      <Text className="text-base leading-6 text-ink">
        Confirm only if that was you, and open the link in the same browser you signed in with.
      </Text>
      <Button
        href={actionUrl}
        className="box-border mt-4 rounded-md bg-ink px-5 py-3 text-center text-base font-semibold text-white no-underline"
      >
        Review and confirm
      </Button>
      <Text className="mt-6 text-sm leading-5 text-muted">
        This single-use link expires {expiryFormat.format(new Date(expiresAt))} UTC. If you weren’t
        expecting it, ignore this message and your account stays unchanged.
      </Text>
    </IdentityEmailLayout>
  );
}

FederatedIdentityLink.PreviewProps = {
  actionUrl: "https://auth.us.deployments.ai/federation/confirm-link#token=preview-token",
  expiresAt: "2026-08-01T12:00:00.000Z",
  identityProvider: { displayName: "Acme Okta", issuer: "https://acme.okta.com" },
  organizationName: "Acme",
} satisfies FederatedIdentityLinkProps;

export default FederatedIdentityLink;
