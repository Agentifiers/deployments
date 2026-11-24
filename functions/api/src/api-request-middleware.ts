import { recordApiCredentialUsageBestEffort } from "@deployments-ai/db";
import { Cause, Effect, Layer } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { problem, webRequest } from "./api-request-authorization.ts";
import {
  ApiProblem,
  ApiRequestContext,
  AuthenticatedIdentity,
  Authentication,
  RequestLifecycle,
  type ApiIdentity,
  type CreateTenancyApiOptions,
} from "./api-service-contracts.ts";

export type RecordAuthenticatedUsage = (identity: ApiIdentity, request: Request) => Promise<void>;

/** Records single-grant API credential usage; best-effort, never rejects. */
export function createAuthenticatedUsageRecorder(
  options: CreateTenancyApiOptions,
): RecordAuthenticatedUsage {
  return async (identity, request) => {
    if (
      identity.authentication !== "api-credential" ||
      !identity.apiCredentialId ||
      identity.organizationIds === "*" ||
      identity.organizationIds?.length !== 1 ||
      identity.projectIds === "*" ||
      identity.projectIds?.length !== 1 ||
      identity.environmentIds === "*" ||
      identity.environmentIds?.length !== 1 ||
      !options.recordApiCredentialUsage
    ) {
      return;
    }
    await recordApiCredentialUsageBestEffort(
      options.recordApiCredentialUsage,
      {
        apiCredentialId: identity.apiCredentialId,
        environmentId: identity.environmentIds[0]!,
        organizationId: identity.organizationIds[0]!,
        outcome: "allowed",
        projectId: identity.projectIds[0]!,
        requestMethod: request.method,
        requestPath: new URL(request.url).pathname,
      },
      (error) => {
        console.error("API credential usage recording failed.", {
          error: error instanceof Error ? error.message : "Unknown recorder error.",
        });
      },
    );
  };
}

export function createApiMiddlewareLayers(
  options: CreateTenancyApiOptions,
  nextRequestId: () => string,
  recordAuthenticatedUsage: RecordAuthenticatedUsage,
) {
  const lifecycleLayer = Layer.succeed(RequestLifecycle, (httpEffect) =>
    Effect.gen(function* () {
      const requestId = nextRequestId();
      return yield* Effect.provideService(
        // Last-resort net for defects; expected failures are mapped by each handler.
        Effect.catchCause(httpEffect, (cause) =>
          Effect.succeed(problem(Cause.squash(cause), requestId)),
        ),
        ApiRequestContext,
        { requestId },
      ).pipe(
        Effect.map((response) => HttpServerResponse.setHeader(response, "x-request-id", requestId)),
      );
    }),
  );

  const authenticationLayer = Layer.succeed(Authentication, {
    bearer: (httpEffect) =>
      Effect.gen(function* () {
        const { requestId } = yield* ApiRequestContext;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const web = webRequest(request);
        const authenticated = yield* Effect.result(
          Effect.tryPromise({
            try: () => options.authenticate(web),
            catch: (cause) => cause,
          }),
        );
        if (authenticated._tag === "Failure") return problem(authenticated.failure, requestId);
        const identity = authenticated.success;
        if (!identity) {
          return problem(
            new ApiProblem(401, "unauthorized", "A valid bearer credential is required."),
            requestId,
          );
        }
        yield* Effect.promise(() => recordAuthenticatedUsage(identity, web));
        return yield* Effect.provideService(httpEffect, AuthenticatedIdentity, identity);
      }),
  });

  return Layer.mergeAll(lifecycleLayer, authenticationLayer);
}
