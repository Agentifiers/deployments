import { Heading, Text } from "react-email";
import { IdentityEmailLayout } from "./layout.tsx";

export function PasswordChanged() {
  return (
    <IdentityEmailLayout preview="Your Deployments.ai password changed">
      <Heading as="h1" className="mb-4 text-2xl font-semibold text-ink">
        Password changed
      </Heading>
      <Text className="text-base leading-6 text-ink">
        Your Deployments.ai password was changed and existing sessions were invalidated.
      </Text>
      <Text className="mt-6 text-sm leading-5 text-muted">
        If this wasn’t you, contact support immediately and secure your email account.
      </Text>
    </IdentityEmailLayout>
  );
}

PasswordChanged.PreviewProps = {};
export default PasswordChanged;
