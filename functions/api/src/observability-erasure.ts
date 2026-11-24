import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  decodeObservabilityErasureResult,
  type ObservabilityErasureRequest,
} from "@deployments-ai/governance";

export const OBSERVABILITY_ERASURE_FUNCTION_ENV =
  "DEPLOYMENTS_AI_OBSERVABILITY_ERASURE_FUNCTION_NAME" as const;

export interface LambdaInvoker {
  readonly send: (command: InvokeCommand) => Promise<{
    readonly FunctionError?: string;
    readonly Payload?: Uint8Array;
  }>;
}

/**
 * Returns the observability erasure invoker, or `undefined` when the
 * observability stack is not deployed for this environment.
 */
export function makeObservabilityErasureInvoker(
  environment: NodeJS.ProcessEnv,
  client: LambdaInvoker = new LambdaClient({}),
) {
  const functionName = environment[OBSERVABILITY_ERASURE_FUNCTION_ENV]?.trim();
  if (!functionName) return undefined;
  return async (request: ObservabilityErasureRequest) => {
    const response = await client.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: "RequestResponse",
        Payload: Buffer.from(JSON.stringify(request)),
      }),
    );
    const payload: unknown = response.Payload
      ? JSON.parse(Buffer.from(response.Payload).toString("utf8"))
      : undefined;
    if (response.FunctionError) {
      const message =
        payload && typeof payload === "object" && "errorMessage" in payload
          ? String(payload.errorMessage)
          : response.FunctionError;
      throw new Error(`Observability erasure failed: ${message}`);
    }
    try {
      return decodeObservabilityErasureResult(payload, request.operationId);
    } catch (cause) {
      throw new Error("Observability erasure failed: the purge returned an invalid response.", {
        cause,
      });
    }
  };
}
