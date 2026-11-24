import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { Heading } from "@/components/ui/heading";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code, Text } from "@/components/ui/text";
import { Timestamp } from "../components/observability/panels.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { systemModelProvidersQuery } from "../data/system-queries.ts";

export const Route = createFileRoute("/system/model-providers")({
  loader: ({ context }) => {
    if (context.platformAdministrator) {
      void context.queryClient.prefetchQuery(systemModelProvidersQuery());
    }
  },
  component: () => (
    <div className="space-y-6">
      <Heading>Model providers</Heading>
      <Text>
        The provider keys the install pays for. The console shows metadata only. Change a key with
        the deploy tool's <Code>secrets sync model-runtime</Code>.
      </Text>
      <SectionBoundary fallback={<Skeleton className="h-32 rounded-lg" />} resetKey="providers">
        <ModelProviders />
      </SectionBoundary>
    </div>
  ),
});

const STORE_LABELS = {
  "secrets-manager": "Secrets Manager",
  "ssm-parameter": "SSM parameter",
  "task-role": "Task role",
} as const;

function ModelProviders() {
  const { data: providers } = useSuspenseQuery(systemModelProvidersQuery());
  if (providers.length === 0) return <Text>This install hosts no model provider.</Text>;
  return (
    <Table dense striped>
      <TableHeader>
        <TableRow>
          <TableHead>Provider</TableHead>
          <TableHead>Key</TableHead>
          <TableHead>Store</TableHead>
          <TableHead>Version</TableHead>
          <TableHead>Last changed</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {providers.map((provider) => (
          <TableRow key={provider.provider}>
            <TableCell className="font-medium">{provider.provider}</TableCell>
            <TableCell>
              <Badge color={provider.configured ? "green" : "amber"}>
                {provider.configured ? "configured" : "not configured"}
              </Badge>
            </TableCell>
            <TableCell>{STORE_LABELS[provider.credentialStore]}</TableCell>
            <TableCell>
              {provider.version === null ? "—" : <Code>{provider.version}</Code>}
            </TableCell>
            <TableCell className="whitespace-nowrap">
              {provider.lastModifiedAt ? <Timestamp value={provider.lastModifiedAt} /> : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
