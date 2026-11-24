import { KMSClient } from "@aws-sdk/client-kms";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import {
  apiPersistence,
  key,
  makeCredentialVault,
  makeTenancyPersistence,
} from "@deployments-ai/db";
import { createRemoteMcpClient } from "@deployments-ai/mcp-client";
import {
  OAUTH_REFRESH_FUNCTION_NAME_ENV,
  PLATFORM_OAUTH_PUBLIC_ORIGIN_ENV,
  PLATFORM_OAUTH_RETURN_ORIGINS_ENV,
  parsePlatformOAuthAppRegistry,
  platformOAuthReturnOrigins,
} from "@deployments-ai/providers";
import { createAdministrationApi } from "./administration-api.ts";
import { makeAdministrationPersistence } from "./administration-persistence.ts";
import {
  API_ENV,
  createApiLambdaHandler,
  freshModelOperatorGrants,
  makeApiIdempotency,
} from "./api-lambda-foundation.ts";
import { makeS3HostedCodeArtifactObjectStore } from "./hosted-code-artifact-administration.ts";
import { requiredEnvironment } from "./lambda-environment.ts";
import { makeAdministrationProviderVerifier } from "./provider-verification.ts";
import { makeVendorMcpAdministrationDependencies } from "./vendor-mcp-runtime.ts";

const ADMINISTRATION_API_ENV = {
  credentialKmsKeyArn: "DEPLOYMENTS_AI_CREDENTIAL_KMS_KEY_ARN",
  oauthApplications: "PLATFORM_OAUTH_APPS_JSON",
} as const;

export const handler = createApiLambdaHandler((foundation, environment) => {
  const { authenticate, database, documentClient, recordApiCredentialUsage, tableNames } =
    foundation;
  const persistence = makeTenancyPersistence({ database });
  const loadModelOperatorGrants = freshModelOperatorGrants(environment);
  const remoteMcp = createRemoteMcpClient({
    clientInfo: { name: "deployments-ai-administration-api", version: "1.0.0" },
  });
  const vendorMcp = makeVendorMcpAdministrationDependencies({
    lambda: new LambdaClient({}),
    mcpClient: remoteMcp,
    publicOrigin: environment[PLATFORM_OAUTH_PUBLIC_ORIGIN_ENV]?.trim() || undefined,
    refreshFunctionName: environment[OAUTH_REFRESH_FUNCTION_NAME_ENV]?.trim() || undefined,
  });
  const administration = makeAdministrationPersistence({
    credentials: makeCredentialVault({
      documentClient,
      kmsClient: new KMSClient({}),
      kmsKeyArn: requiredEnvironment(environment, ADMINISTRATION_API_ENV.credentialKmsKeyArn),
      tableName: tableNames.control,
    }),
    database,
    hostedCodeArtifacts: makeS3HostedCodeArtifactObjectStore({
      bucket: requiredEnvironment(environment, API_ENV.artifactBucket),
      client: new S3Client({}),
      kmsKeyArn: requiredEnvironment(environment, API_ENV.artifactKmsKeyArn),
    }),
    ...(loadModelOperatorGrants ? { loadModelOperatorGrants } : {}),
    mcpDiscovery: {
      discover: async (input) =>
        (
          await remoteMcp.discoverTools({
            endpointOrigin: input.endpointOrigin,
            endpointPath: input.endpointPath,
            ...(input.headers ? { headers: input.headers } : {}),
            timeoutMs: 25_000,
            toolAllowlist: input.toolAllowlist,
          })
        ).tools,
    },
    oauthApplications: parsePlatformOAuthAppRegistry(
      requiredEnvironment(environment, ADMINISTRATION_API_ENV.oauthApplications),
    ),
    oauthReturnOrigins: platformOAuthReturnOrigins(environment[PLATFORM_OAUTH_RETURN_ORIGINS_ENV]),
    providerVerification: makeAdministrationProviderVerifier(),
    resolveEnvironment: async (invocation) => {
      if (!invocation.identity || !invocation.scope.environmentId) return undefined;
      const resolved = await persistence.environments.get({
        body: undefined,
        id: invocation.scope.environmentId,
        identity: invocation.identity,
        query: {},
        scope: { environmentId: invocation.scope.environmentId },
      });
      return {
        id: resolved.id,
        organizationId: resolved.organizationId,
        projectId: resolved.projectId,
        status: resolved.status,
      };
    },
    resolveWorkspace: async (scope, workspaceId) => {
      const record = await apiPersistence.read(
        database,
        "control",
        {
          pk: key("ORG", scope.organizationId, "ENV", scope.id),
          sk: key("WORKSPACE", workspaceId),
        },
        true,
      );
      return (
        record?.itemType === "workspace" &&
        record.data.environmentId === scope.id &&
        record.data.organizationId === scope.organizationId &&
        record.data.projectId === scope.projectId &&
        record.data.status === "active"
      );
    },
    ...(vendorMcp ? { vendorMcp } : {}),
  });
  return createAdministrationApi({
    authenticate,
    authorize: async (invocation, operationName, mutation) => {
      if (!invocation.identity) return;
      await persistence.authorize(
        {
          body: invocation.body,
          ...(invocation.id ? { id: invocation.id } : {}),
          identity: invocation.identity,
          ...(invocation.idempotencyKey ? { idempotencyKey: invocation.idempotencyKey } : {}),
          query: invocation.query,
          scope: invocation.scope,
        },
        operationName,
        mutation,
      );
    },
    idempotency: makeApiIdempotency({ database, environment }).idempotency,
    recordApiCredentialUsage,
    service: administration,
  });
});
