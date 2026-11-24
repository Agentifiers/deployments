import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  ReplaceSystemPrincipalStatusRequest,
  type SystemPrincipalStatusResponse,
} from "@deployments-ai/api-contract/system";
import {
  PrincipalStatusCommand,
  Ulid,
  principalStatusOutcomeFromReply,
  type PrincipalStatusRepository,
} from "@deployments-ai/db";
import { Schema } from "effect";
import type { LambdaInvoker } from "../observability-erasure.ts";
import { SystemOperatorProblem, parseBody } from "./service.ts";

export const PRINCIPAL_STATUS_FUNCTION_ENV = "DEPLOYMENTS_AI_PRINCIPAL_STATUS_FUNCTION_NAME";

const decodeUlid = Schema.decodeUnknownSync(Ulid);
const decodeRequest = Schema.decodeUnknownSync(ReplaceSystemPrincipalStatusRequest, {
  onExcessProperty: "error",
});
const encodeCommand = Schema.encodeSync(PrincipalStatusCommand);

/**
 * Platform identity owns sign-in state, so the API asks identity's principal status function to
 * change a person's status. Installs without platform identity name no function.
 */
export function identityPrincipalStatus(
  environment: NodeJS.ProcessEnv,
  client: LambdaInvoker = new LambdaClient({}),
): PrincipalStatusRepository | undefined {
  const functionName = environment[PRINCIPAL_STATUS_FUNCTION_ENV]?.trim();
  if (!functionName) return undefined;
  return {
    async setStatus(change) {
      const response = await client.send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: "RequestResponse",
          Payload: Buffer.from(JSON.stringify(encodeCommand(change))),
        }),
      );
      if (response.FunctionError || !response.Payload) {
        throw new Error(
          `Principal status function failed: ${response.FunctionError ?? "empty response"}`,
        );
      }
      return principalStatusOutcomeFromReply(
        JSON.parse(Buffer.from(response.Payload).toString("utf8")),
      );
    },
  };
}

export type SystemPrincipalStatus = (change: {
  readonly body: unknown;
  readonly operatorId: string;
  readonly principalId: string;
}) => Promise<typeof SystemPrincipalStatusResponse.Encoded>;

export function makeSystemPrincipalStatus(
  statuses: PrincipalStatusRepository | undefined,
): SystemPrincipalStatus {
  return async ({ body, operatorId, principalId }) => {
    const { reason, status } = parseBody(decodeRequest, body);
    if (!statuses) {
      throw new SystemOperatorProblem(
        409,
        "principal_status_unmanaged",
        "This install does not run platform identity, so its identity provider manages people's status.",
      );
    }
    return statuses.setStatus({
      actorPrincipalId: decodeUlid(operatorId),
      principalId: decodeUlid(principalId),
      reason,
      status,
    });
  };
}
