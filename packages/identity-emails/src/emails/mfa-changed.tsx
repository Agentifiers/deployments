import { Heading, Text } from "react-email";
import { IdentityEmailLayout } from "./layout.tsx";

export interface MfaChangedProps {
  readonly change: "disabled" | "enabled";
}

const COPY = {
  disabled: {
    body: "Two-factor authentication was turned off for your Deployments.ai account. Signing in now needs only your password.",
    heading: "Two-factor authentication turned off",
  },
  enabled: {
    body: "Two-factor authentication was turned on for your Deployments.ai account. Signing in with a password now also needs a code from your authenticator app or a recovery code.",
    heading: "Two-factor authentication turned on",
  },
} as const;

export function MfaChanged({ change }: MfaChangedProps) {
  const copy = COPY[change];
  return (
    <IdentityEmailLayout preview={copy.heading}>
      <Heading as="h1" className="mb-4 text-2xl font-semibold text-ink">
        {copy.heading}
      </Heading>
      <Text className="text-base leading-6 text-ink">{copy.body}</Text>
      <Text className="mt-6 text-sm leading-5 text-muted">
        If this wasn’t you, reset your password, sign out everywhere, and contact support.
      </Text>
    </IdentityEmailLayout>
  );
}

MfaChanged.PreviewProps = { change: "enabled" } satisfies MfaChangedProps;
export default MfaChanged;
