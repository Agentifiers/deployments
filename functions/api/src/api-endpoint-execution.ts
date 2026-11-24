import {
  decodeTenancyIdempotencyKey,
  decodeTenancyQuery,
  tenancyRouteContract,
} from "@deployments-ai/api-contract";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { type EndpointOperation } from "./endpoint-operations.ts";
import { type OperationalReadInvocation } from "./operational-reads.ts";
import {
  assertScope,
  capabilities,
  idempotencyOwner,
  problem,
  requestBody,
  resultOrganizationId,
  scopeHeader,
  webRequest,
  type RawEndpointInput,
} from "./api-request-authorization.ts";
import {
  ApiProblem,
  ApiRequestContext,
  AuthenticatedIdentity,
  agentRouteNames,
  explicitEnvironmentGrantRouteNames,
  type ApiIdentity,
  type ApiInvocation,
  type CreateTenancyApiOptions,
} from "./api-service-contracts.ts";
import { fingerprint } from "./idempotency-fingerprint.ts";
import { permits } from "./scope-permissions.ts";

export function createEndpointExecutors(options: CreateTenancyApiOptions) {
  const execute = <Body, Success>(
    input: RawEndpointInput,
    endpoint: EndpointOperation<Body, Success>,
  ) =>
    Effect.gen(function* () {
      const identity = yield* AuthenticatedIdentity;
      const { requestId } = yield* ApiRequestContext;
      return yield* Effect.tryPromise({
        try: async () => {
          const contract = tenancyRouteContract(endpoint.routeName);
          if (!permits(identity.scopes, capabilities[endpoint.routeName])) {
            throw new ApiProblem(
              403,
              "insufficient_scope",
              "The credential does not have the required capability scope.",
            );
          }

          const request = webRequest(input.request);
          const url = new URL(request.url);
          const header = scopeHeader(contract.scope);
          const scopeValue = header
            ? request.headers.get(header[0])?.trim() || undefined
            : undefined;
          assertScope(
            identity,
            contract.scope,
            scopeValue,
            !explicitEnvironmentGrantRouteNames.has(endpoint.routeName),
          );
          const scope = header && scopeValue ? { [header[1]]: scopeValue } : {};
          const query =
            contract.method === "GET" && contract.name.startsWith("list")
              ? (decodeTenancyQuery(
                  endpoint.routeName,
                  Object.fromEntries(url.searchParams),
                ) as ApiInvocation["query"])
              : {};
          const body = endpoint.decodeBody(
            contract.requestBody
              ? await requestBody(request, contract.requestBodyRequired === false)
              : undefined,
          );
          const idempotencyKey = contract.idempotent
            ? (decodeTenancyIdempotencyKey(
                endpoint.routeName,
                request.headers.get("idempotency-key") ?? undefined,
              ) as string)
            : undefined;
          const invocation: ApiInvocation<Body> = {
            body,
            identity,
            ...(input.params?.id ? { id: input.params.id as string } : {}),
            ...(idempotencyKey ? { idempotencyKey } : {}),
            query,
            scope,
          };
          await options.authorize(invocation, endpoint.routeName, contract.method !== "GET");
          const targetEnvironmentId = endpoint.targetEnvironmentId?.(body);
          let operationInvocation = invocation;
          if (targetEnvironmentId !== undefined) {
            // A request-selected tenant JWT also selects the declared target; environment-bound
            // JWTs and API keys keep their single grant. The target is then authorized like the
            // source: same organization and project grants plus the capability and role there.
            const targetIdentity: ApiIdentity =
              identity.environmentSelection === "request" && Array.isArray(identity.environmentIds)
                ? {
                    ...identity,
                    environmentIds: [...identity.environmentIds, targetEnvironmentId],
                  }
                : identity;
            assertScope(
              targetIdentity,
              "environment",
              targetEnvironmentId,
              !explicitEnvironmentGrantRouteNames.has(endpoint.routeName),
            );
            operationInvocation = { ...invocation, identity: targetIdentity };
            await options.authorize(
              { ...operationInvocation, scope: { environmentId: targetEnvironmentId } },
              endpoint.routeName,
              true,
            );
          }
          const operation = () => endpoint.operation(operationInvocation);
          const idempotencyOwnerValue = idempotencyOwner(
            identity,
            scope,
            contract.scope,
            agentRouteNames.has(endpoint.routeName),
          );
          const result = idempotencyKey
            ? await options.idempotency.execute({
                fingerprint: fingerprint(endpoint.routeName, invocation),
                key: idempotencyKey,
                operation,
                ...idempotencyOwnerValue,
                principalId: identity.principalId,
                resolveOrganizationId: (result) => resultOrganizationId(endpoint.routeName, result),
              })
            : await operation();
          const decoded = endpoint.decodeResponse(result);
          const status = endpoint.successStatus?.(result);
          return status === undefined
            ? decoded
            : HttpServerResponse.jsonUnsafe(decoded, { status });
        },
        catch: (cause) => cause,
      }).pipe(Effect.catch((cause) => Effect.succeed(problem(cause, requestId))));
    });

  const executeOperational = <Success>(
    input: RawEndpointInput,
    requiredScope: string,
    operation: (invocation: OperationalReadInvocation) => Promise<Success>,
    scope: "environment" | "organization" = "environment",
  ) =>
    Effect.gen(function* () {
      const identity = yield* AuthenticatedIdentity;
      const { requestId } = yield* ApiRequestContext;
      return yield* Effect.tryPromise({
        try: async () => {
          if (!permits(identity.scopes, requiredScope)) {
            throw new ApiProblem(
              403,
              "insufficient_scope",
              "The credential does not have the required capability scope.",
            );
          }
          const request = webRequest(input.request);
          const scopeId = request.headers.get(`x-deployments-${scope}`)?.trim() || undefined;
          assertScope(identity, scope, scopeId, false);
          const query = Object.fromEntries(new URL(request.url).searchParams);
          return operation({
            ...(input.params?.id ? { id: input.params.id } : {}),
            identity,
            query,
            scope: !scopeId
              ? {}
              : scope === "organization"
                ? { organizationId: scopeId }
                : { environmentId: scopeId },
          });
        },
        catch: (cause) => cause,
      }).pipe(Effect.catch((cause) => Effect.succeed(problem(cause, requestId))));
    });

  return { execute, executeOperational };
}
