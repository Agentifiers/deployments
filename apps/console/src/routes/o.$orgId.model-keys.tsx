import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ModelKeys } from "../components/models/model-keys.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { modelKeysQuery } from "../data/model-key-queries.ts";
import { useInstallCopy } from "../edition.ts";
import { Heading } from "@/components/ui/heading";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";

export const Route = createFileRoute("/o/$orgId/model-keys")({
  loader: async ({ context, params }) => {
    const { access } = await context.queryClient.ensureQueryData(
      organizationShellQuery(params.orgId),
    );
    if (access.getModelCredential) {
      void context.queryClient.prefetchQuery(modelKeysQuery(params.orgId));
    }
  },
  component: ModelKeysPage,
});

function ModelKeysPage() {
  const { orgId } = Route.useParams();
  const {
    data: { access },
  } = useSuspenseQuery(organizationShellQuery(orgId));
  const copy = useInstallCopy();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Heading>Model keys</Heading>
        <Text>
          Model calls to a provider with a key here use that key, so the provider bills the
          organization directly. Other model calls are paid by {copy.operatorFundedPayer}.
        </Text>
      </div>
      {access.getModelCredential ? (
        <SectionBoundary fallback={<Skeleton className="h-32 rounded-lg" />} resetKey={orgId}>
          <ModelKeys access={access} copy={copy} organizationId={orgId} />
        </SectionBoundary>
      ) : (
        <Text>Only organization owners and admins manage model keys (models:read).</Text>
      )}
    </div>
  );
}
