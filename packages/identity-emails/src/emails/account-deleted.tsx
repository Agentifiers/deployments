import { Heading, Text } from "react-email";
import { IdentityEmailLayout } from "./layout.tsx";

export function AccountDeleted() {
  return (
    <IdentityEmailLayout preview="Your Deployments.ai account was deleted">
      <Heading as="h1" className="mb-4 text-2xl font-semibold text-ink">
        Account deleted
      </Heading>
      <Text className="text-base leading-6 text-ink">
        Your Deployments.ai account was deleted. Every session signed out, you left your
        organizations, and your name and email address were removed from the account. This email
        address can now be used for a new account.
      </Text>
      <Text className="mt-6 text-sm leading-5 text-muted">
        If you didn’t delete your account, contact support immediately and secure your email
        account.
      </Text>
    </IdentityEmailLayout>
  );
}

AccountDeleted.PreviewProps = {};
export default AccountDeleted;
