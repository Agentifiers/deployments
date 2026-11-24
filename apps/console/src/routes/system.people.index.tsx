import { PUBLIC_ID_PATTERN } from "@deployments-ai/api-contract/primitives";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Heading } from "@/components/ui/heading";
import { Text } from "@/components/ui/text";
import { PersonSearch } from "../components/system/person-search.tsx";

export const Route = createFileRoute("/system/people/")({
  validateSearch: (search): { readonly principalId?: string } =>
    typeof search["principalId"] === "string" ? { principalId: search["principalId"] } : {},
  // Older links pass the principal as a query; the person page owns that view now.
  beforeLoad: ({ search }) => {
    if (search.principalId && PUBLIC_ID_PATTERN.test(search.principalId)) {
      throw redirect({
        params: { principalId: search.principalId },
        replace: true,
        to: "/system/people/$principalId",
      });
    }
  },
  component: People,
});

function People() {
  const navigate = Route.useNavigate();
  return (
    <div className="space-y-6">
      <Heading>People</Heading>
      <Text>
        Find a person by email to see their organizations, sign-in state, and security events, and
        to disable them, end their sessions, or resend a sign-up's verification email.
      </Text>
      <PersonSearch
        initialPrincipalId={Route.useSearch().principalId ?? ""}
        onPrincipalId={(principalId) =>
          void navigate({ params: { principalId }, to: "/system/people/$principalId" })
        }
      />
    </div>
  );
}
