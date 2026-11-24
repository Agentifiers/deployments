import { WorkspaceSpendResponse } from "@deployments-ai/api-contract";
import {
  apiPersistence,
  key,
  readMonthSpend,
  requestedSpendMonth,
  type DynamoDatabaseService,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Option, Schema } from "effect";
import { OperationalReadError } from "./operational-read-input.ts";

type Environment = Extract<PlatformRecord, { readonly itemType: "environment" }>;

const decodeWorkspaceSpend = Schema.decodeUnknownSync(WorkspaceSpendResponse);

/**
 * One workspace's spend in a UTC month, split by who paid. An archived workspace stays readable,
 * so its last months can still be billed.
 */
export async function readWorkspaceSpend(
  database: DynamoDatabaseService,
  input: {
    readonly asOf: Date;
    readonly environment: Environment;
    readonly month: string | undefined;
    readonly workspaceId: string | undefined;
  },
) {
  const { asOf, environment } = input;
  if (!input.workspaceId) {
    throw new OperationalReadError(400, "invalid_request", "Workspace id is required.");
  }
  const month = Option.getOrThrowWith(
    requestedSpendMonth(input.month, asOf),
    () =>
      new OperationalReadError(
        400,
        "invalid_month",
        "month must be a UTC month as YYYY-MM, no later than the current month.",
      ),
  );
  const workspace = await apiPersistence.read(
    database,
    "control",
    {
      pk: key("ORG", environment.data.organizationId, "ENV", environment.data.id),
      sk: key("WORKSPACE", input.workspaceId),
    },
    true,
  );
  if (workspace?.itemType !== "workspace") {
    throw new OperationalReadError(404, "not_found", "Workspace was not found.");
  }
  const { environmentId, id: workspaceId, organizationId, projectId } = workspace.data;
  const spend = await readMonthSpend(
    database,
    organizationId,
    { environmentId, projectId, scope: "workspace", workspaceId },
    asOf,
    month,
  );
  return decodeWorkspaceSpend({ ...spend, environmentId, month, workspaceId });
}
