import { useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { agentDetailQuery } from "../../data/agent-queries.ts";
import { agentUsageQuery } from "../../data/usage-queries.ts";
import { formatExact, formatUsdMicros } from "../../observability/format.ts";
import type { EnvironmentScope } from "../../scope.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Text } from "@/components/ui/text";
import { agentDeploymentSplit } from "../../usage/agent-usage.ts";
import type { UsagePeriod } from "../../usage/selection.ts";
import { releaseLabel } from "../agents/agent-header.tsx";
import { GroupedMetricChart } from "../observability/charts.tsx";
import { ChartPanel } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { Swatch } from "./breakdown-section.tsx";

const numberCell = "text-right tabular-nums";
const OTHER_LABEL = "Other deployments";

/**
 * Agent detail Usage tab breakdown (plan §6.1 tab 9): the split of the agent's tokens and cost
 * across its deployments, from the observability hot plane (analytics). The agent's totals come
 * from the usage ledger (`LedgerSection` with its definition).
 */
export function AgentDeploymentUsage({
  definitionId,
  period,
  scope,
}: Readonly<{ definitionId: string; period: UsagePeriod; scope: EnvironmentScope }>) {
  const { data: agent } = useSuspenseQuery(agentDetailQuery(scope, definitionId));
  const { data: usage } = useSuspenseQuery(agentUsageQuery(scope, definitionId, period));
  const { buckets, split } = useMemo(() => {
    const deployments = new Map<string, (typeof agent.deployments)[number]>(
      agent.deployments.map((deployment) => [deployment.id, deployment]),
    );
    const { groups, ...values } = agentDeploymentSplit(
      usage,
      new Set(deployments.keys()),
      OTHER_LABEL,
    );
    // Charts name deployments by their short ID and pinned release.
    const labeled = groups.map((group) => {
      const deployment = group.groupValue ? deployments.get(group.groupValue) : undefined;
      if (!deployment) return { ...group, release: undefined };
      const release = releaseLabel(agent, deployment.agentReleaseId);
      return { ...group, label: `…${deployment.id.slice(-8)} (${release})`, release };
    });
    return {
      buckets: usage.rows.map((row) => row.bucket),
      split: { ...values, groups: labeled },
    };
  }, [agent, usage]);
  const { interval } = usage.window;
  if (usage.status !== "found") {
    return (
      <Text>
        {usage.status === "absent"
          ? "This agent finished no traces in this period."
          : "This agent is not among the environment's 20 busiest agents, and it finished more traces in this period than are totalled from the trace list. Choose a shorter period."}
      </Text>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <Text>
        {usage.basis === "metrics"
          ? "Totals for this agent from the environment's metrics, which cover its 20 busiest agents."
          : "Totals added up from this agent's traces, because metrics cover only the environment's 20 busiest agents."}
      </Text>
      <section className="flex flex-col gap-4">
        {split.groups.length === 0 ? (
          <Text>No deployment of this agent finished traces in this period.</Text>
        ) : (
          <>
            {usage.deployments.complete ? null : (
              <Text>
                Metrics list the environment's 20 busiest deployments. Usage by this agent&apos;s
                other deployments is grouped as {OTHER_LABEL.toLowerCase()}.
              </Text>
            )}
            <div className="grid gap-4 lg:grid-cols-2">
              <ChartPanel description="Tokens by deployment" title="Tokens">
                <GroupedMetricChart
                  buckets={buckets}
                  format="count"
                  groups={split.groups}
                  interval={interval}
                  kind="bars"
                  values={split.tokens}
                />
              </ChartPanel>
              <ChartPanel description="Model cost by deployment" title="Cost">
                <GroupedMetricChart
                  buckets={buckets}
                  format="usd"
                  groups={split.groups}
                  interval={interval}
                  kind="bars"
                  values={split.costUsdMicros}
                />
              </ChartPanel>
            </div>
            <Table dense>
              <TableHeader>
                <TableRow>
                  <TableHead>Deployment</TableHead>
                  <TableHead>Release</TableHead>
                  <TableHead className={numberCell}>Traces</TableHead>
                  <TableHead className={numberCell}>Tokens</TableHead>
                  <TableHead className={numberCell}>Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {split.groups.map((group, index) => (
                  <TableRow key={group.key}>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <Swatch group={group} index={index} />
                        {group.groupValue === null ? (
                          group.label
                        ) : (
                          <PublicId value={group.groupValue} />
                        )}
                      </span>
                    </TableCell>
                    <TableCell>{group.release ?? "—"}</TableCell>
                    <TableCell className={numberCell}>{formatExact(group.totals.traces)}</TableCell>
                    <TableCell className={numberCell}>{formatExact(group.totals.tokens)}</TableCell>
                    <TableCell className={numberCell}>
                      {formatUsdMicros(group.totals.costUsdMicros)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </section>
    </div>
  );
}
