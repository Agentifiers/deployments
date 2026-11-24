import { Button, Heading, Text } from "react-email";
import { IdentityEmailLayout } from "./layout.tsx";

export interface VerifyEmailProps {
  readonly actionUrl: string;
}

export function VerifyEmail({ actionUrl }: VerifyEmailProps) {
  return (
    <IdentityEmailLayout preview="Verify your Deployments.ai email address">
      <Heading as="h1" className="mb-4 text-2xl font-semibold text-ink">
        Verify your email
      </Heading>
      <Text className="text-base leading-6 text-ink">
        Confirm that this email address belongs to you. You’ll choose your password after opening
        the secure link.
      </Text>
      <Button
        href={actionUrl}
        className="box-border mt-4 rounded-md bg-ink px-5 py-3 text-center text-base font-semibold text-white no-underline"
      >
        Verify email
      </Button>
      <Text className="mt-6 text-sm leading-5 text-muted">
        If you didn’t start this signup, you can safely ignore this message.
      </Text>
    </IdentityEmailLayout>
  );
}

VerifyEmail.PreviewProps = {
  actionUrl: "https://auth.us.deployments.ai/verify#verify=preview-token",
} satisfies VerifyEmailProps;

export default VerifyEmail;
