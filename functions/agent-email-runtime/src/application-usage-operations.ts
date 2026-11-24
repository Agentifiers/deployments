import {
  type AgentEmailUsageBucket,
  type AgentEmailUsageExportRecord,
} from "@deployments-ai/agent-email";
import { AgentEmailUsageQuery } from "@deployments-ai/api-contract/agent-email";
import { Schema } from "effect";
import { type AgentEmailApiInvocation } from "./api-handler.ts";

import type { AgentEmailApplicationContext } from "./application-service-context.ts";
import {
  apiError,
  MAX_PUBLIC_USAGE_RANGE_MILLISECONDS,
  MAX_PUBLIC_USAGE_RECORDS,
  queryString,
} from "./application-service-support.ts";

export function createAgentEmailUsageOperations(context: AgentEmailApplicationContext) {
  const { now, scoped } = context;
  function validateUsageRange(from: string, to: string) {
    const fromTime = new Date(from).getTime();
    const toTime = new Date(to).getTime();
    if (!Number.isFinite(fromTime) || !Number.isFinite(toTime)) {
      apiError(400, "invalid_usage_range", "from and to must be valid ISO-8601 timestamps.");
    }
    if (fromTime > toTime) {
      apiError(400, "invalid_usage_range", "from must be before or equal to to.");
    }
    if (toTime - fromTime > MAX_PUBLIC_USAGE_RANGE_MILLISECONDS) {
      apiError(400, "invalid_usage_range", "Usage ranges cannot exceed 31 days.");
    }
    return { from, to };
  }

  function getUsageRange(invocation: AgentEmailApiInvocation) {
    let input: typeof AgentEmailUsageQuery.Type;
    try {
      input = Schema.decodeUnknownSync(AgentEmailUsageQuery)({
        ...(queryString(invocation, "from") ? { from: queryString(invocation, "from") } : {}),
        ...(queryString(invocation, "inboxId")
          ? { inboxId: queryString(invocation, "inboxId") }
          : {}),
        ...(queryString(invocation, "to") ? { to: queryString(invocation, "to") } : {}),
      });
    } catch {
      apiError(
        400,
        "invalid_usage_range",
        "Usage filters require canonical UTC timestamps and a canonical inbox ID.",
      );
    }
    const to = input.to ?? now();
    const from = input.from ?? new Date(Date.parse(to) - 30 * 24 * 60 * 60 * 1_000).toISOString();
    return {
      ...validateUsageRange(from, to),
      ...(input.inboxId ? { inboxId: input.inboxId } : {}),
    };
  }

  async function usageRows(
    invocation: AgentEmailApiInvocation,
    input: {
      readonly bucket: AgentEmailUsageBucket;
      readonly from: string;
      readonly inboxId?: string;
      readonly to: string;
    },
  ) {
    const meters = await scoped(invocation).usageRecords({
      from: input.from,
      ...(input.inboxId ? { inboxId: input.inboxId } : {}),
      maxRecords: MAX_PUBLIC_USAGE_RECORDS,
      to: input.to,
    });
    const bucketStart = (timestamp: string) => {
      const date = new Date(timestamp);
      if (input.bucket === "month") {
        date.setUTCDate(1);
        date.setUTCHours(0, 0, 0, 0);
      } else if (input.bucket === "day") {
        date.setUTCHours(0, 0, 0, 0);
      } else {
        date.setUTCMinutes(0, 0, 0);
      }
      return date.toISOString();
    };
    const rows = new Map<string, AgentEmailUsageExportRecord>();
    for (const meter of meters) {
      const data = meter.data;
      if (
        data.source !== "agent-email" ||
        data.occurredAt < input.from ||
        data.occurredAt > input.to ||
        (input.inboxId && data.dimensions.inboxId !== input.inboxId)
      ) {
        continue;
      }
      const kind = data.metric.replace(
        /^agent_email\./u,
        "",
      ) as AgentEmailUsageExportRecord["kind"];
      if (
        !["attachment_bytes", "inbound_message", "outbound_message", "stored_bytes"].includes(kind)
      ) {
        continue;
      }
      const start = bucketStart(data.occurredAt);
      const clientId =
        typeof data.dimensions.clientId === "string" ? data.dimensions.clientId : undefined;
      const inboxId =
        typeof data.dimensions.inboxId === "string" ? data.dimensions.inboxId : undefined;
      const key = `${start}:${clientId ?? ""}:${inboxId ?? ""}:${kind}`;
      const previous = rows.get(key);
      rows.set(key, {
        bucketStart: start,
        ...(clientId ? { clientId } : {}),
        ...(inboxId ? { inboxId } : {}),
        kind,
        organizationId: invocation.scope.organizationId,
        quantity: (previous?.quantity ?? 0) + data.quantity,
      });
    }
    return [...rows.values()].sort((left, right) =>
      left.bucketStart.localeCompare(right.bucketStart),
    );
  }

  return { getUsageRange, usageRows, validateUsageRange };
}
