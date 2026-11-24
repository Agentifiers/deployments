import {
  TENANCY_API_SCHEMAS,
  decodeTenancyRequest,
  decodeTenancyResponse,
  type TenancyRouteName,
} from "@deployments-ai/api-contract";
import { Schema } from "effect";
import type { AgentReleasePromotionResult, ApiInvocation } from "./index.ts";

export const schemas = TENANCY_API_SCHEMAS;

export function responseDecoder<Success>(
  routeName: TenancyRouteName,
  decode: (input: unknown) => Success,
) {
  return (input: unknown): Success => decode(decodeTenancyResponse(routeName, input));
}

export function requestDecoder<Body>(
  routeName: TenancyRouteName,
  decode: (input: unknown) => Body,
) {
  return (input: unknown): Body => decode(decodeTenancyRequest(routeName, input));
}

export const noRequestBody = (): undefined => undefined;

export function serviceOperation<Body, Success>(
  execute: ((invocation: ApiInvocation<Body>) => Promise<Success>) | undefined,
  label: string,
) {
  return (invocation: ApiInvocation<Body>) => {
    if (!execute) return Promise.reject(new Error(`${label} service is not configured.`));
    return execute(invocation);
  };
}

export interface EndpointOperation<Body, Success> {
  readonly decodeBody: (input: unknown) => Body;
  readonly decodeResponse: (input: unknown) => Success;
  readonly operation: (invocation: ApiInvocation<Body>) => Promise<unknown>;
  readonly routeName: TenancyRouteName;
  /** Response status derived from the (possibly replayed) operation result. */
  readonly successStatus?: (result: unknown) => number;
  /** Further environments the caller must be able to mutate, such as a promotion target. */
  readonly targetEnvironmentId?: (body: Body) => string;
}

export function endpointOperation<Body, Success>(
  routeName: TenancyRouteName,
  decodeBody: (input: unknown) => Body,
  operation: (invocation: ApiInvocation<Body>) => Promise<Success>,
  decodeResponse: (input: unknown) => Success,
): EndpointOperation<Body, Success> {
  return { decodeBody, decodeResponse, operation, routeName };
}

/** Promotion answers 201 when it created the target release and 200 when it already existed. */
export function promoteAgentReleaseOperation(
  execute: (
    invocation: ApiInvocation<typeof schemas.PromoteAgentReleaseRequest.Type>,
  ) => Promise<AgentReleasePromotionResult>,
): EndpointOperation<
  typeof schemas.PromoteAgentReleaseRequest.Type,
  typeof schemas.AgentReleaseResponse.Type
> {
  const decodeRelease = responseDecoder("promoteAgentRelease", (input) =>
    Schema.decodeUnknownSync(schemas.AgentReleaseResponse)(input),
  );
  return {
    decodeBody: requestDecoder("promoteAgentRelease", (input) =>
      Schema.decodeUnknownSync(schemas.PromoteAgentReleaseRequest)(input),
    ),
    decodeResponse: (input) => decodeRelease((input as AgentReleasePromotionResult).release),
    operation: execute,
    routeName: "promoteAgentRelease",
    successStatus: (input) => ((input as AgentReleasePromotionResult).created ? 201 : 200),
    targetEnvironmentId: (body) => body.targetEnvironmentId,
  };
}
