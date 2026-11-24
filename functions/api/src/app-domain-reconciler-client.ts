import { InvokeCommand } from "@aws-sdk/client-lambda";
import type { AppDomainRecord } from "@deployments-ai/db";

/**
 * Queues a convergence of one domain and returns once Lambda accepted it. The reconciler runs one
 * invocation at a time, so the queued run may wait for a sweep. `refresh` re-requests a failed or
 * timed-out certificate.
 */
export type AppDomainReconcile = (
  domain: AppDomainRecord,
  options: { readonly refresh: boolean },
) => Promise<void>;

export function lambdaAppDomainReconcile(options: {
  readonly client: {
    readonly send: (
      command: InvokeCommand,
      handlerOptions: { readonly abortSignal?: AbortSignal },
    ) => Promise<unknown>;
  };
  readonly deadlineMs: number;
  readonly functionName: string;
}): AppDomainReconcile {
  return async ({ data }, { refresh }) => {
    await options.client.send(
      new InvokeCommand({
        FunctionName: options.functionName,
        InvocationType: "Event",
        Payload: Buffer.from(
          JSON.stringify({
            appId: data.appId,
            domainId: data.id,
            kind: "domain",
            organizationId: data.organizationId,
            refresh,
          }),
        ),
      }),
      { abortSignal: AbortSignal.timeout(options.deadlineMs) },
    );
  };
}
