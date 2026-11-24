import type { ReactNode } from "react";
import { Subheading } from "@/components/ui/heading";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { SectionBoundary } from "../../section-boundary.tsx";

/** A titled tab section whose data loads, and fails, on its own. */
export function RuntimeBlock({
  children,
  description,
  title,
}: Readonly<{ children: ReactNode; description: ReactNode; title: string }>) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <Subheading>{title}</Subheading>
        <Text>{description}</Text>
      </div>
      <SectionBoundary fallback={<Skeleton className="h-32 rounded-lg" />} resetKey={title}>
        {children}
      </SectionBoundary>
    </section>
  );
}
