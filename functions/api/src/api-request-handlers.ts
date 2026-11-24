import { makePublicOpenApiSpec, type PublicOpenApiSpec } from "@deployments-ai/api-contract";
import { effectiveOrganizationCapabilities } from "@deployments-ai/db";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { randomUUID } from "node:crypto";
import { createEndpointExecutors } from "./api-endpoint-execution.ts";
import {
  createApiMiddlewareLayers,
  createAuthenticatedUsageRecorder,
} from "./api-request-middleware.ts";
import { createTenancyEndpointOperations } from "./endpoint-operations.ts";

import { TenancyHttpApi, problem, requestBody, webRequest } from "./api-request-authorization.ts";
import {
  ApiProblem,
  ApiRequestContext,
  type CreateTenancyApiOptions,
} from "./api-service-contracts.ts";
export function createTenancyApi(options: CreateTenancyApiOptions) {
  const nextRequestId = () => options.requestId?.() ?? `req_${randomUUID()}`;
  const recordAuthenticatedUsage = createAuthenticatedUsageRecorder(options);
  const middlewareLayers = createApiMiddlewareLayers(
    options,
    nextRequestId,
    recordAuthenticatedUsage,
  );
  const { execute, executeOperational } = createEndpointExecutors(options);
  const operations = createTenancyEndpointOperations(options.service);
  const buildOpenApiSpec = options.openApiSpec ?? makePublicOpenApiSpec;
  let openApiSpec: PublicOpenApiSpec | undefined;
  const systemHandlers = HttpApiBuilder.group(TenancyHttpApi, "system", (handlers) =>
    handlers
      .handle("health", () =>
        Effect.succeed({ status: "ok" as const, service: "deployments-ai-api" as const }),
      )
      .handle("openapi", () =>
        Effect.sync(() => HttpServerResponse.jsonUnsafe((openApiSpec ??= buildOpenApiSpec()))),
      ),
  ).pipe(Layer.provide(middlewareLayers));
  const securityHandlers = HttpApiBuilder.group(TenancyHttpApi, "security", (handlers) =>
    handlers.handleRaw("getIdentity", (input) =>
      Effect.gen(function* () {
        const { requestId } = yield* ApiRequestContext;
        return yield* Effect.tryPromise({
          try: async () => {
            const request = webRequest(input.request);
            const identity =
              (await options.authenticate(request)) ??
              (await options.authenticateIdentity?.(request)) ??
              null;
            if (!identity) {
              throw new ApiProblem(401, "unauthorized", "A valid bearer credential is required.");
            }
            await recordAuthenticatedUsage(identity, request);
            const token =
              request.headers
                .get("authorization")
                ?.match(/^Bearer\s+(.+)$/iu)?.[1]
                ?.trim() ?? "";
            const organizationIds =
              identity.organizationIds === "*" ? [] : [...(identity.organizationIds ?? [])];
            const projectIds = identity.projectIds === "*" ? [] : [...(identity.projectIds ?? [])];
            const environmentIds =
              identity.environmentIds === "*" ? [] : [...(identity.environmentIds ?? [])];
            // Human callers that select an organization see what their role lets them do there.
            const organizationSelected = Boolean(
              request.headers.get("x-deployments-organization")?.trim(),
            );
            const organizationRole = organizationSelected ? identity.organizationRole : undefined;
            const platformRole = organizationSelected ? identity.platformRole : undefined;
            return HttpServerResponse.jsonUnsafe(
              {
                authentication:
                  identity.authentication ??
                  (token.split(".").length === 3 ? "tenant-jwt" : "api-credential"),
                capabilities:
                  organizationRole && !platformRole
                    ? [...effectiveOrganizationCapabilities(organizationRole, identity.scopes)]
                    : [...identity.scopes],
                environmentIds,
                id: identity.principalId,
                organizationIds,
                ...(organizationRole ? { organizationRole } : {}),
                ...(platformRole ? { platformRole } : {}),
                projectIds,
                ...(environmentIds.length === 1 ? { environmentId: environmentIds[0] } : {}),
                ...(organizationIds.length === 1 ? { organizationId: organizationIds[0] } : {}),
                ...(projectIds.length === 1 ? { projectId: projectIds[0] } : {}),
                ...(identity.workspaceId ? { workspaceId: identity.workspaceId } : {}),
              },
              { headers: { "cache-control": "no-store" } },
            );
          },
          catch: (cause) => cause,
        }).pipe(Effect.catch((cause) => Effect.succeed(problem(cause, requestId))));
      }),
    ),
  ).pipe(Layer.provide(middlewareLayers));
  const deviceAuthorizationHandlers = HttpApiBuilder.group(
    TenancyHttpApi,
    "deviceAuthorization",
    (handlers) =>
      handlers
        .handleRaw("startDeviceAuthorization", (input) =>
          Effect.gen(function* () {
            const { requestId } = yield* ApiRequestContext;
            return yield* Effect.tryPromise({
              try: async () => {
                const body = await requestBody(webRequest(input.request), false);
                if (
                  !body ||
                  typeof body !== "object" ||
                  (body as Readonly<Record<string, unknown>>).clientId !== "deployments-cli"
                ) {
                  throw new ApiProblem(400, "invalid_request", "clientId must be deployments-cli.");
                }
                if (!options.deviceAuthorization) {
                  throw new ApiProblem(
                    503,
                    "device_authorization_unavailable",
                    "Device authorization is not configured.",
                  );
                }
                return HttpServerResponse.jsonUnsafe(await options.deviceAuthorization.start(), {
                  headers: { "cache-control": "no-store", pragma: "no-cache" },
                });
              },
              catch: (cause) => cause,
            }).pipe(Effect.catch((cause) => Effect.succeed(problem(cause, requestId))));
          }),
        )
        .handleRaw("exchangeDeviceAuthorization", (input) =>
          Effect.gen(function* () {
            const { requestId } = yield* ApiRequestContext;
            return yield* Effect.tryPromise({
              try: async () => {
                const body = await requestBody(webRequest(input.request), false);
                const deviceCode =
                  body &&
                  typeof body === "object" &&
                  typeof (body as Readonly<Record<string, unknown>>).deviceCode === "string"
                    ? ((body as Readonly<Record<string, unknown>>).deviceCode as string)
                    : undefined;
                const refreshToken =
                  body &&
                  typeof body === "object" &&
                  typeof (body as Readonly<Record<string, unknown>>).refreshToken === "string"
                    ? ((body as Readonly<Record<string, unknown>>).refreshToken as string)
                    : undefined;
                if (Boolean(deviceCode) === Boolean(refreshToken)) {
                  throw new ApiProblem(
                    400,
                    "invalid_request",
                    "Provide exactly one of deviceCode or refreshToken.",
                  );
                }
                if (!options.deviceAuthorization) {
                  throw new ApiProblem(
                    503,
                    "device_authorization_unavailable",
                    "Device authorization is not configured.",
                  );
                }
                const token = deviceCode
                  ? await options.deviceAuthorization.exchange(deviceCode)
                  : await options.deviceAuthorization.refresh(refreshToken!);
                return HttpServerResponse.jsonUnsafe(token, {
                  headers: { "cache-control": "no-store", pragma: "no-cache" },
                });
              },
              catch: (cause) => cause,
            }).pipe(Effect.catch((cause) => Effect.succeed(problem(cause, requestId))));
          }),
        )
        .handleRaw("revokeDeviceAuthorization", (input) =>
          Effect.gen(function* () {
            const { requestId } = yield* ApiRequestContext;
            return yield* Effect.tryPromise({
              try: async () => {
                const body = await requestBody(webRequest(input.request), false);
                const refreshToken =
                  body &&
                  typeof body === "object" &&
                  typeof (body as Readonly<Record<string, unknown>>).refreshToken === "string"
                    ? ((body as Readonly<Record<string, unknown>>).refreshToken as string)
                    : undefined;
                if (!refreshToken) {
                  throw new ApiProblem(400, "invalid_request", "refreshToken is required.");
                }
                if (!options.deviceAuthorization) {
                  throw new ApiProblem(
                    503,
                    "device_authorization_unavailable",
                    "Device authorization is not configured.",
                  );
                }
                await options.deviceAuthorization.revoke(refreshToken);
                return HttpServerResponse.jsonUnsafe(
                  { revoked: true },
                  { headers: { "cache-control": "no-store", pragma: "no-cache" } },
                );
              },
              catch: (cause) => cause,
            }).pipe(Effect.catch((cause) => Effect.succeed(problem(cause, requestId))));
          }),
        ),
  ).pipe(Layer.provide(middlewareLayers));
  const tenancyHandlers = HttpApiBuilder.group(TenancyHttpApi, "tenancy", (handlers) =>
    handlers
      .handleRaw("listOrganizations", (input) => execute(input, operations.listOrganizations))
      .handleRaw("createOrganization", (input) => execute(input, operations.createOrganization))
      .handleRaw("getOrganization", (input) => execute(input, operations.getOrganization))
      .handleRaw("updateOrganization", (input) => execute(input, operations.updateOrganization))
      .handleRaw("getOrganizationLimits", (input) =>
        execute(input, operations.getOrganizationLimits),
      )
      .handleRaw("getOrganizationStanding", (input) =>
        execute(input, operations.getOrganizationStanding),
      )
      .handleRaw("listOrganizationMembers", (input) =>
        execute(input, operations.listOrganizationMembers),
      )
      .handleRaw("addOrganizationMember", (input) =>
        execute(input, operations.addOrganizationMember),
      )
      .handleRaw("updateOrganizationMember", (input) =>
        execute(input, operations.updateOrganizationMember),
      )
      .handleRaw("removeOrganizationMember", (input) =>
        execute(input, operations.removeOrganizationMember),
      )
      .handleRaw("listOrganizationInvitations", (input) =>
        execute(input, operations.listOrganizationInvitations),
      )
      .handleRaw("createOrganizationInvitation", (input) =>
        execute(input, operations.createOrganizationInvitation),
      )
      .handleRaw("revokeOrganizationInvitation", (input) =>
        execute(input, operations.revokeOrganizationInvitation),
      )
      .handleRaw("acceptOrganizationInvitation", (input) =>
        execute(input, operations.acceptOrganizationInvitation),
      )
      .handleRaw("listProjects", (input) => execute(input, operations.listProjects))
      .handleRaw("createProject", (input) => execute(input, operations.createProject))
      .handleRaw("getProject", (input) => execute(input, operations.getProject))
      .handleRaw("updateProject", (input) => execute(input, operations.updateProject))
      .handleRaw("archiveProject", (input) => execute(input, operations.archiveProject))
      .handleRaw("listEnvironments", (input) => execute(input, operations.listEnvironments))
      .handleRaw("createEnvironment", (input) => execute(input, operations.createEnvironment))
      .handleRaw("getEnvironment", (input) => execute(input, operations.getEnvironment))
      .handleRaw("updateEnvironment", (input) => execute(input, operations.updateEnvironment))
      .handleRaw("archiveEnvironment", (input) => execute(input, operations.archiveEnvironment))
      .handleRaw("listWorkspaces", (input) => execute(input, operations.listWorkspaces))
      .handleRaw("createWorkspace", (input) => execute(input, operations.createWorkspace))
      .handleRaw("getWorkspace", (input) => execute(input, operations.getWorkspace))
      .handleRaw("updateWorkspace", (input) => execute(input, operations.updateWorkspace))
      .handleRaw("archiveWorkspace", (input) => execute(input, operations.archiveWorkspace))
      .handleRaw("listServiceAccounts", (input) => execute(input, operations.listServiceAccounts))
      .handleRaw("createServiceAccount", (input) => execute(input, operations.createServiceAccount))
      .handleRaw("getServiceAccount", (input) => execute(input, operations.getServiceAccount))
      .handleRaw("revokeServiceAccount", (input) => execute(input, operations.revokeServiceAccount))
      .handleRaw("listApiCredentials", (input) => execute(input, operations.listApiCredentials))
      .handleRaw("createApiCredential", (input) => execute(input, operations.createApiCredential))
      .handleRaw("rotateApiCredential", (input) => execute(input, operations.rotateApiCredential))
      .handleRaw("revokeApiCredential", (input) => execute(input, operations.revokeApiCredential)),
  ).pipe(Layer.provide(middlewareLayers));
  const agentHandlers = HttpApiBuilder.group(TenancyHttpApi, "agents", (handlers) =>
    handlers
      .handleRaw("listAgentDefinitions", (input) => execute(input, operations.listAgentDefinitions))
      .handleRaw("createAgentDefinition", (input) =>
        execute(input, operations.createAgentDefinition),
      )
      .handleRaw("getAgentDefinition", (input) => execute(input, operations.getAgentDefinition))
      .handleRaw("updateAgentDefinition", (input) =>
        execute(input, operations.updateAgentDefinition),
      )
      .handleRaw("archiveAgentDefinition", (input) =>
        execute(input, operations.archiveAgentDefinition),
      )
      .handleRaw("listAgentReleases", (input) => execute(input, operations.listAgentReleases))
      .handleRaw("publishAgentRelease", (input) => execute(input, operations.publishAgentRelease))
      .handleRaw("getAgentRelease", (input) => execute(input, operations.getAgentRelease))
      .handleRaw("archiveAgentRelease", (input) => execute(input, operations.archiveAgentRelease))
      .handleRaw("promoteAgentRelease", (input) => execute(input, operations.promoteAgentRelease))
      .handleRaw("listAgentDeployments", (input) => execute(input, operations.listAgentDeployments))
      .handleRaw("createAgentDeployment", (input) =>
        execute(input, operations.createAgentDeployment),
      )
      .handleRaw("getAgentDeployment", (input) => execute(input, operations.getAgentDeployment))
      .handleRaw("updateAgentDeployment", (input) =>
        execute(input, operations.updateAgentDeployment),
      )
      .handleRaw("stopAgentDeployment", (input) => execute(input, operations.stopAgentDeployment))
      .handleRaw("startAgentDeploymentCanary", (input) =>
        execute(input, operations.startAgentDeploymentCanary),
      )
      .handleRaw("promoteAgentDeploymentCanary", (input) =>
        execute(input, operations.promoteAgentDeploymentCanary),
      )
      .handleRaw("abortAgentDeploymentCanary", (input) =>
        execute(input, operations.abortAgentDeploymentCanary),
      ),
  ).pipe(Layer.provide(middlewareLayers));
  const operationalHandlers = HttpApiBuilder.group(TenancyHttpApi, "operations", (handlers) =>
    handlers
      .handleRaw("listUsageRecords", (input) =>
        executeOperational(input, "usage:read", (invocation) => {
          if (!options.operationalReads)
            throw new ApiProblem(500, "internal_error", "Operational reads are not configured.");
          return options.operationalReads.listUsage(invocation);
        }),
      )
      .handleRaw("getUsageSummary", (input) =>
        executeOperational(input, "usage:read", (invocation) => {
          if (!options.operationalReads)
            throw new ApiProblem(500, "internal_error", "Operational reads are not configured.");
          return options.operationalReads.getUsageSummary(invocation);
        }),
      )
      .handleRaw("listCostRecords", (input) =>
        executeOperational(input, "spend:read", (invocation) => {
          if (!options.operationalReads)
            throw new ApiProblem(500, "internal_error", "Operational reads are not configured.");
          return options.operationalReads.listCosts(invocation);
        }),
      )
      .handleRaw("getCostSummary", (input) =>
        executeOperational(input, "spend:read", (invocation) => {
          if (!options.operationalReads)
            throw new ApiProblem(500, "internal_error", "Operational reads are not configured.");
          return options.operationalReads.getCostSummary(invocation);
        }),
      )
      .handleRaw("getWorkspaceSpend", (input) =>
        executeOperational(input, "spend:read", (invocation) => {
          if (!options.operationalReads)
            throw new ApiProblem(500, "internal_error", "Operational reads are not configured.");
          return options.operationalReads.getWorkspaceSpend(invocation);
        }),
      )
      .handleRaw("listSpendRecords", (input) =>
        executeOperational(input, "spend:read", (invocation) => {
          if (!options.operationalReads)
            throw new ApiProblem(500, "internal_error", "Operational reads are not configured.");
          return options.operationalReads.listSpend(invocation);
        }),
      )
      .handleRaw("listApiCredentialUsage", (input) =>
        executeOperational(input, "api-keys:read", (invocation) => {
          if (!options.operationalReads)
            throw new ApiProblem(500, "internal_error", "Operational reads are not configured.");
          return options.operationalReads.listApiCredentialUsage(invocation);
        }),
      )
      .handleRaw("listAuditEvents", (input) =>
        executeOperational(input, "audit:read", (invocation) => {
          if (!options.operationalReads)
            throw new ApiProblem(500, "internal_error", "Operational reads are not configured.");
          return options.operationalReads.listAuditEvents(invocation);
        }),
      )
      .handleRaw("getAuditEvent", (input) =>
        executeOperational(input, "audit:read", (invocation) => {
          if (!options.operationalReads)
            throw new ApiProblem(500, "internal_error", "Operational reads are not configured.");
          return options.operationalReads.getAuditEvent(invocation);
        }),
      )
      .handleRaw("listOrganizationAuditEvents", (input) =>
        executeOperational(
          input,
          "audit:read",
          (invocation) => {
            if (!options.operationalReads)
              throw new ApiProblem(500, "internal_error", "Operational reads are not configured.");
            return options.operationalReads.listOrganizationAuditEvents(invocation);
          },
          "organization",
        ),
      ),
  ).pipe(Layer.provide(middlewareLayers));
  const workflowHandlers = HttpApiBuilder.group(TenancyHttpApi, "workflows", (handlers) =>
    handlers
      .handleRaw("listWorkflowDefinitions", (input) =>
        execute(input, operations.listWorkflowDefinitions),
      )
      .handleRaw("createWorkflowDefinition", (input) =>
        execute(input, operations.createWorkflowDefinition),
      )
      .handleRaw("getWorkflowDefinition", (input) =>
        execute(input, operations.getWorkflowDefinition),
      )
      .handleRaw("updateWorkflowDefinition", (input) =>
        execute(input, operations.updateWorkflowDefinition),
      )
      .handleRaw("archiveWorkflowDefinition", (input) =>
        execute(input, operations.archiveWorkflowDefinition),
      )
      .handleRaw("listWorkflowReleases", (input) => execute(input, operations.listWorkflowReleases))
      .handleRaw("publishWorkflowRelease", (input) =>
        execute(input, operations.publishWorkflowRelease),
      )
      .handleRaw("getWorkflowRelease", (input) => execute(input, operations.getWorkflowRelease))
      .handleRaw("archiveWorkflowRelease", (input) =>
        execute(input, operations.archiveWorkflowRelease),
      ),
  ).pipe(Layer.provide(middlewareLayers));
  const managedSkillHandlers = HttpApiBuilder.group(TenancyHttpApi, "managedSkills", (handlers) =>
    handlers
      .handleRaw("listManagedSkillSources", (input) =>
        execute(input, operations.listManagedSkillSources),
      )
      .handleRaw("createManagedSkillSource", (input) =>
        execute(input, operations.createManagedSkillSource),
      )
      .handleRaw("getManagedSkillSource", (input) =>
        execute(input, operations.getManagedSkillSource),
      )
      .handleRaw("updateManagedSkillSource", (input) =>
        execute(input, operations.updateManagedSkillSource),
      )
      .handleRaw("archiveManagedSkillSource", (input) =>
        execute(input, operations.archiveManagedSkillSource),
      )
      .handleRaw("listManagedSkillReleases", (input) =>
        execute(input, operations.listManagedSkillReleases),
      )
      .handleRaw("publishManagedSkillRelease", (input) =>
        execute(input, operations.publishManagedSkillRelease),
      )
      .handleRaw("getManagedSkillRelease", (input) =>
        execute(input, operations.getManagedSkillRelease),
      )
      .handleRaw("archiveManagedSkillRelease", (input) =>
        execute(input, operations.archiveManagedSkillRelease),
      )
      .handleRaw("listManagedSkills", (input) => execute(input, operations.listManagedSkills))
      .handleRaw("getManagedSkill", (input) => execute(input, operations.getManagedSkill))
      .handleRaw("listManagedSkillInstallations", (input) =>
        execute(input, operations.listManagedSkillInstallations),
      )
      .handleRaw("installManagedSkill", (input) => execute(input, operations.installManagedSkill))
      .handleRaw("getManagedSkillInstallation", (input) =>
        execute(input, operations.getManagedSkillInstallation),
      )
      .handleRaw("removeManagedSkillInstallation", (input) =>
        execute(input, operations.removeManagedSkillInstallation),
      ),
  ).pipe(Layer.provide(middlewareLayers));

  const fallback = HttpRouter.add("*", "/*", () => {
    const requestId = nextRequestId();
    return Effect.succeed(
      problem(
        new ApiProblem(404, "route_not_found", "The requested API route does not exist."),
        requestId,
      ),
    );
  });
  const routes = Layer.mergeAll(HttpApiBuilder.layer(TenancyHttpApi), fallback).pipe(
    Layer.provide(
      Layer.mergeAll(
        systemHandlers,
        deviceAuthorizationHandlers,
        securityHandlers,
        tenancyHandlers,
        agentHandlers,
        operationalHandlers,
        workflowHandlers,
        managedSkillHandlers,
      ),
    ),
    Layer.provide(HttpServer.layerServices),
  );
  return HttpRouter.toWebHandler(routes, { disableLogger: true }).handler;
}
