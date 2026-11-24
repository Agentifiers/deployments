import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading, Subheading } from "@/components/ui/heading";
import { Code, Text } from "@/components/ui/text";
import { Timestamp } from "../components/observability/panels.tsx";
import { systemInstallationQuery } from "../data/console-queries.ts";

export const Route = createFileRoute("/system/")({
  loader: ({ context }) =>
    context.platformAdministrator
      ? context.queryClient.ensureQueryData(systemInstallationQuery())
      : undefined,
  component: SystemOverview,
});

function SystemOverview() {
  const { data: installation } = useSuspenseQuery(systemInstallationQuery());
  return (
    <div className="space-y-10">
      <Heading>Install</Heading>
      {installation === null ? (
        <Text>
          No deployment has been recorded for this install yet. <Code>bun run deploy</Code> records
          it after verification passes.
        </Text>
      ) : (
        <>
          <DescriptionList>
            <DescriptionTerm>Target</DescriptionTerm>
            <DescriptionDetails>{installation.targetName}</DescriptionDetails>
            <DescriptionTerm>Profile</DescriptionTerm>
            <DescriptionDetails>{installation.profile}</DescriptionDetails>
            <DescriptionTerm>AWS account</DescriptionTerm>
            <DescriptionDetails>
              <Code>{installation.awsAccountId}</Code> · {installation.awsRegion}
            </DescriptionDetails>
            <DescriptionTerm>Source commit</DescriptionTerm>
            <DescriptionDetails>
              <Code>{installation.sourceCommit}</Code>
            </DescriptionDetails>
            <DescriptionTerm>Release manifest</DescriptionTerm>
            <DescriptionDetails>
              <Code>{installation.releaseManifestSha256}</Code>
            </DescriptionDetails>
            <DescriptionTerm>Deployed</DescriptionTerm>
            <DescriptionDetails>
              <Timestamp value={installation.deployedAt} /> by {installation.deployedBy}
            </DescriptionDetails>
          </DescriptionList>
          <section className="space-y-4">
            <Subheading>Endpoints</Subheading>
            <DescriptionList>
              {installation.endpoints.map((endpoint) => [
                <DescriptionTerm key={`${endpoint.name}-term`}>{endpoint.name}</DescriptionTerm>,
                <DescriptionDetails key={`${endpoint.name}-url`}>
                  <Code>{endpoint.url}</Code>
                </DescriptionDetails>,
              ])}
            </DescriptionList>
          </section>
        </>
      )}
    </div>
  );
}
