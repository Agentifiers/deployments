import { Heading, Text } from "react-email";
import { IdentityEmailLayout } from "./layout.tsx";

export function RefreshReuse() {
  return (
    <IdentityEmailLayout preview="Deployments.ai blocked a reused sign-in credential">
      <Heading as="h1" className="mb-4 text-2xl font-semibold text-ink">
        Sign-in credential reuse detected
      </Heading>
      <Text className="text-base leading-6 text-ink">
        We detected a refresh credential being presented more than once. The affected session was
        revoked to protect your account.
      </Text>
      <Text className="mt-6 text-sm leading-5 text-muted">
        Sign in again. If you don’t recognize this activity, change your password immediately.
      </Text>
    </IdentityEmailLayout>
  );
}

RefreshReuse.PreviewProps = {};
export default RefreshReuse;
