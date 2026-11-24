import { Route01Icon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { useInstallCopy } from "../../edition.ts";
import { PlatformApiError } from "../../errors.ts";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Icon } from "../icon.tsx";

/** The API answers every observability read with this code when the hot plane is off or down. */
export function isObservabilityUnavailable(error: unknown): boolean {
  return error instanceof PlatformApiError && error.problem.code === "observability_unavailable";
}

/** The one message every traces, metrics, and run-totals section shows when observability is down. */
export function ObservabilityUnavailable({ children }: Readonly<{ children?: ReactNode }>) {
  const copy = useInstallCopy();
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon icon={Route01Icon} />
        </EmptyMedia>
        <EmptyTitle>Observability is unavailable</EmptyTitle>
        <EmptyDescription>{copy.observabilityUnavailable}</EmptyDescription>
      </EmptyHeader>
      {children ? <EmptyContent>{children}</EmptyContent> : null}
    </Empty>
  );
}
