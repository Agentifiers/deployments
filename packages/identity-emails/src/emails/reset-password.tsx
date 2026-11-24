import { Button, Heading, Text } from "react-email";
import { IdentityEmailLayout } from "./layout.tsx";

export interface ResetPasswordProps {
  readonly actionUrl: string;
}

export function ResetPassword({ actionUrl }: ResetPasswordProps) {
  return (
    <IdentityEmailLayout preview="Reset your Deployments.ai password">
      <Heading as="h1" className="mb-4 text-2xl font-semibold text-ink">
        Reset your password
      </Heading>
      <Text className="text-base leading-6 text-ink">
        A password reset was requested for your account. This single-use link expires soon.
      </Text>
      <Button
        href={actionUrl}
        className="box-border mt-4 rounded-md bg-ink px-5 py-3 text-center text-base font-semibold text-white no-underline"
      >
        Reset password
      </Button>
      <Text className="mt-6 text-sm leading-5 text-muted">
        If you didn’t request a reset, leave your password unchanged and ignore this message.
      </Text>
    </IdentityEmailLayout>
  );
}

ResetPassword.PreviewProps = {
  actionUrl: "https://auth.us.deployments.ai/reset-password#reset=preview-token",
} satisfies ResetPasswordProps;

export default ResetPassword;
