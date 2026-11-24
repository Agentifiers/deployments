import { createFileRoute } from "@tanstack/react-router";
import { Heading, Subheading } from "@/components/ui/heading";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { SystemAlarms, SystemComponents } from "../components/system/system-health.tsx";
import { systemAlarmsQuery, systemComponentsQuery } from "../data/system-queries.ts";

export const Route = createFileRoute("/system/health")({
  loader: ({ context }) => {
    if (!context.platformAdministrator) return;
    void context.queryClient.prefetchQuery(systemAlarmsQuery());
    void context.queryClient.prefetchQuery(systemComponentsQuery());
  },
  component: () => (
    <div className="space-y-10">
      <Heading>Health</Heading>
      <section className="space-y-4">
        <Subheading>Alarms</Subheading>
        <SectionBoundary fallback={<Skeleton className="h-32 rounded-lg" />} resetKey="alarms">
          <SystemAlarms />
        </SectionBoundary>
      </section>
      <section className="space-y-4">
        <Subheading>Components</Subheading>
        <SectionBoundary fallback={<Skeleton className="h-64 rounded-lg" />} resetKey="components">
          <SystemComponents />
        </SectionBoundary>
      </section>
    </div>
  ),
});
