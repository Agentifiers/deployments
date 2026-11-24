import { Robot01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { agentListQuery } from "../../data/agent-queries.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Icon } from "../icon.tsx";

/**
 * Shown on the overview of an environment that has never had an agent, where every other block
 * reads zero. It renders nothing while the list loads or if it fails, since the rest of the page
 * still works.
 */
export function FirstAgent({ scope }: Readonly<{ scope: EnvironmentScope }>) {
  const { data } = useQuery(agentListQuery(scope, false));
  if (!data || data.rows.length > 0 || data.hiddenArchived > 0) return null;
  return (
    <Empty className="border border-dashed border-border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon icon={Robot01Icon} />
        </EmptyMedia>
        <EmptyTitle>Create your first agent</EmptyTitle>
        <EmptyDescription>
          This environment has no agents yet. Create one, deploy it, and its runs, traces, and costs
          show up here.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button href={`${environmentPath(scope)}/agents`}>
          <Icon icon={PlusSignIcon} />
          Create an agent
        </Button>
      </EmptyContent>
    </Empty>
  );
}
