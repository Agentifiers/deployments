import { Heading, Text } from "react-email";
import { IdentityEmailLayout } from "./layout.tsx";

export function EmailChangeReported() {
  return (
    <IdentityEmailLayout preview="An email change on Deployments.ai was reported">
      <Heading as="h1" className="mb-4 text-2xl font-semibold text-ink">
        Email change reported
      </Heading>
      <Text className="text-base leading-6 text-ink">
        A Deployments.ai account recently changed its email to this address. Its previous address
        reported that change as one it did not make. The account moves back to the previous address
        if nobody else has taken it. Every session signed out, and the password stopped working.
      </Text>
      <Text className="text-base leading-6 text-ink">
        To sign in again, reset the password. The reset link goes to the address the account uses
        now.
      </Text>
      <Text className="mt-6 text-sm leading-5 text-muted">
        If you made the change yourself, contact support.
      </Text>
    </IdentityEmailLayout>
  );
}

EmailChangeReported.PreviewProps = {};
export default EmailChangeReported;
