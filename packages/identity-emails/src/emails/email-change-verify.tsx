import { Button, Heading, Text } from "react-email";
import { expiryFormat, IdentityEmailLayout } from "./layout.tsx";

export interface EmailChangeVerifyProps {
  readonly actionUrl: string;
  readonly expiresAt: string;
}

export function EmailChangeVerify({ actionUrl, expiresAt }: EmailChangeVerifyProps) {
  return (
    <IdentityEmailLayout preview="Confirm your new Deployments.ai email address">
      <Heading as="h1" className="mb-4 text-2xl font-semibold text-ink">
        Confirm your new email
      </Heading>
      <Text className="text-base leading-6 text-ink">
        Someone asked to move a Deployments.ai account to this email address. Your email changes
        only after you open the link and confirm. Every session on the account then signs out.
      </Text>
      <Button
        href={actionUrl}
        className="box-border mt-4 rounded-md bg-ink px-5 py-3 text-center text-base font-semibold text-white no-underline"
      >
        Review and confirm
      </Button>
      <Text className="mt-6 text-sm leading-5 text-muted">
        This single-use link expires {expiryFormat.format(new Date(expiresAt))} UTC. If you didn’t
        ask for this, ignore this message and nothing changes.
      </Text>
    </IdentityEmailLayout>
  );
}

EmailChangeVerify.PreviewProps = {
  actionUrl: "https://auth.us.deployments.ai/email-change/confirm#token=preview-token",
  expiresAt: "2026-08-01T12:00:00.000Z",
} satisfies EmailChangeVerifyProps;

export default EmailChangeVerify;
