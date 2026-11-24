import { Button, Heading, Text } from "react-email";
import { expiryFormat, IdentityEmailLayout } from "./layout.tsx";

export interface EmailChangedProps {
  readonly actionUrl: string;
  readonly expiresAt: string;
  readonly newEmail: string;
}

export function EmailChanged({ actionUrl, expiresAt, newEmail }: EmailChangedProps) {
  return (
    <IdentityEmailLayout preview="Your Deployments.ai email address changed">
      <Heading as="h1" className="mb-4 text-2xl font-semibold text-ink">
        Your email address changed
      </Heading>
      <Text className="text-base leading-6 text-ink">
        Your Deployments.ai account now signs in with {newEmail} instead of this address. Every
        session on the account was signed out.
      </Text>
      <Text className="text-base leading-6 text-ink">
        If you didn’t make this change, report it. That signs everyone out again and moves the
        account back to this address if no one else has taken it.
      </Text>
      <Button
        href={actionUrl}
        className="box-border mt-4 rounded-md bg-ink px-5 py-3 text-center text-base font-semibold text-white no-underline"
      >
        This wasn’t me
      </Button>
      <Text className="mt-6 text-sm leading-5 text-muted">
        You can report the change until {expiryFormat.format(new Date(expiresAt))} UTC. After you
        report it, reset your password and contact support.
      </Text>
    </IdentityEmailLayout>
  );
}

EmailChanged.PreviewProps = {
  actionUrl: "https://auth.us.deployments.ai/email-change/report#token=preview-token",
  expiresAt: "2026-08-08T12:00:00.000Z",
  newEmail: "ada@new.example",
} satisfies EmailChangedProps;

export default EmailChanged;
