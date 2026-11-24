import type { SystemOrganizationSpendResponse } from "@deployments-ai/api-contract/system";
import {
  readMonthSpend,
  requestedSpendMonth,
  Ulid,
  type DynamoDatabaseService,
} from "@deployments-ai/db";
import { Option, Schema } from "effect";
import { SystemOperatorProblem } from "./service.ts";

const decodeUlid = Schema.decodeUnknownSync(Ulid);

/** An organization's spend in `month` (`YYYY-MM`, the current UTC month when absent). */
export type SystemOrganizationSpend = (
  organizationId: string,
  month: string | undefined,
) => Promise<typeof SystemOrganizationSpendResponse.Encoded>;

export function makeSystemOrganizationSpend(dependencies: {
  readonly database: DynamoDatabaseService;
  readonly now?: () => Date;
}): SystemOrganizationSpend {
  const now = dependencies.now ?? (() => new Date());
  return async (organizationId, requested) => {
    const asOf = now();
    const month = Option.getOrThrowWith(
      requestedSpendMonth(requested, asOf),
      () =>
        new SystemOperatorProblem(
          400,
          "invalid_month",
          "month must be a UTC month as YYYY-MM, no later than the current month.",
        ),
    );
    const spend = await readMonthSpend(
      dependencies.database,
      decodeUlid(organizationId),
      { scope: "organization" },
      asOf,
      month,
    );
    return { ...spend, month, organizationId };
  };
}
