import { makePublicOpenApiSpec } from "@deployments-ai/api-contract";
import {
  composeManifestAdmission,
  makeDirectory,
  makeKmsOpaqueCursorCodec,
  makeManifestModelAdmission,
  makeTenancyPersistence,
  withAgentLifecyclePersistence,
  type TenancyPersistence,
} from "@deployments-ai/db";
import { parsePlatformJwtAudience } from "@deployments-ai/identity/platform-jwt";
import { makeManifestToolBoundaryAdmission } from "@deployments-ai/tools";
import {
  API_ENV,
  createApiLambdaHandler,
  freshModelOperatorGrants,
  makeApiIdempotency,
} from "./api-lambda-foundation.ts";
import { createTenancyApi } from "./api-request-handlers.ts";
import type { CreateTenancyApiOptions } from "./api-service-contracts.ts";
import { appsApiFromEnvironment } from "./apps-api.ts";
import { createMemoryJwtIdentityAuthenticator } from "./application-auth.ts";
import { makeControlResourceApiServices } from "./control-resource-api.ts";
import { createDirectoryApi } from "./directory-api.ts";
import { egressAllowlistApiFromEnvironment } from "./egress-allowlist-api.ts";
import {
  deviceAuthorizationAudienceIsCompatible,
  deviceAuthorizationProfile,
} from "./device-authorization-profile.ts";
import { createDeviceAuthorizationService } from "./device-authorization.ts";
import { invitationEmailFromEnvironment } from "./invitation-email-config.ts";
import { identityFederationApiFromEnvironment } from "./identity-federation-api.ts";
import { requiredEnvironment } from "./lambda-environment.ts";
import { modelCredentialsApiFromEnvironment } from "./model-credentials-api.ts";
import {
  createOperationalReadService,
  makeAesGcmOperationalCursorCodec,
} from "./operational-reads.ts";
import { makeOrganizationLimitsApiService } from "./organization-limits-api.ts";
import { organizationCreationFromEnvironment } from "./organization-creation-config.ts";
import { organizationSpendApiFromEnvironment } from "./organization-spend-api.ts";
import { makeOrganizationStandingApiService } from "./organization-standing-api.ts";
import { planFeaturesFromEnvironment } from "./plan-features.ts";
import { adaptTenancyPersistence } from "./tenancy-persistence-adapter.ts";
import { createScimApi } from "./scim/scim-api.ts";

const TENANCY_API_ENV = {
  agentEmailApiEnabled: "DEPLOYMENTS_AI_AGENT_EMAIL_API_ENABLED",
  cursorKeyHex: "DEPLOYMENTS_AI_API_CURSOR_KEY_HEX",
  deviceAuthorizationClientId: "DEPLOYMENTS_AI_DEVICE_AUTHORIZATION_CLIENT_ID",
  deviceAuthorizationIssuer: "DEPLOYMENTS_AI_DEVICE_AUTHORIZATION_ISSUER",
  memoryJwtAudience: "DEPLOYMENTS_AI_MEMORY_JWT_AUDIENCE",
  memoryJwtIssuer: "DEPLOYMENTS_AI_MEMORY_JWT_ISSUER",
  memoryJwksUri: "DEPLOYMENTS_AI_MEMORY_JWKS_URI",
} as const;

export function makeRuntimeTenancyAuthorizer(
  persistence: Pick<TenancyPersistence, "authorize">,
): CreateTenancyApiOptions["authorize"] {
  return (invocation, operationName, mutation) =>
    persistence.authorize(invocation, operationName, mutation);
}

export const handler = createApiLambdaHandler((foundation, environment, gate) => {
  const { authenticate, database, jwt, recordApiCredentialUsage } = foundation;
  const idempotencyKmsKeyArn = requiredEnvironment(environment, API_ENV.idempotencyKmsKeyArn);
  const deviceAuthorizationProviderProfile = deviceAuthorizationProfile(jwt.claimProfile);
  const memoryIssuer = requiredEnvironment(environment, TENANCY_API_ENV.memoryJwtIssuer);
  const memoryAudience = parsePlatformJwtAudience(
    requiredEnvironment(environment, TENANCY_API_ENV.memoryJwtAudience),
    TENANCY_API_ENV.memoryJwtAudience,
  );
  const cursorKeyHex = environment[TENANCY_API_ENV.cursorKeyHex]?.trim();
  if (cursorKeyHex && !/^[0-9a-f]{64}$/iu.test(cursorKeyHex)) {
    throw new Error(`${TENANCY_API_ENV.cursorKeyHex} must contain 32 hexadecimal bytes.`);
  }
  const cursorCodec = cursorKeyHex
    ? makeAesGcmOperationalCursorCodec(Buffer.from(cursorKeyHex, "hex"))
    : makeKmsOpaqueCursorCodec({
        encryptionContext: { purpose: "operational-read-cursor" },
        kmsKeyArn: idempotencyKmsKeyArn,
      });
  const deviceAuthorizationClientId =
    environment[TENANCY_API_ENV.deviceAuthorizationClientId]?.trim() || undefined;
  const deviceAuthorizationIssuer =
    environment[TENANCY_API_ENV.deviceAuthorizationIssuer]?.trim() || undefined;
  if (Boolean(deviceAuthorizationClientId) !== Boolean(deviceAuthorizationIssuer)) {
    throw new Error(
      `${TENANCY_API_ENV.deviceAuthorizationClientId} and ${TENANCY_API_ENV.deviceAuthorizationIssuer} must be configured together.`,
    );
  }
  if (
    deviceAuthorizationClientId &&
    deviceAuthorizationIssuer &&
    (deviceAuthorizationIssuer.replace(/\/+$/u, "") !== jwt.issuer.replace(/\/+$/u, "") ||
      !deviceAuthorizationAudienceIsCompatible(
        deviceAuthorizationProviderProfile,
        jwt.audience,
        deviceAuthorizationClientId,
      ))
  ) {
    throw new Error(
      "Device authorization must use an issuer and bearer audience accepted by the platform JWT authenticator.",
    );
  }
  const invitationEmail = invitationEmailFromEnvironment(environment);
  const persistence = withAgentLifecyclePersistence(
    makeTenancyPersistence({
      database,
      ...(invitationEmail ? { invitationEmail } : {}),
      organizationCreation: organizationCreationFromEnvironment(environment, jwt.claimProfile),
    }),
    {
      admitManifest: composeManifestAdmission(
        makeManifestModelAdmission(database, freshModelOperatorGrants(environment)),
        makeManifestToolBoundaryAdmission({ database }),
      ),
      database,
    },
  );
  const idempotency = makeApiIdempotency({ database, environment }).idempotency;
  const tenancy = createTenancyApi({
    authorize: makeRuntimeTenancyAuthorizer(persistence),
    authenticate,
    authenticateIdentity: createMemoryJwtIdentityAuthenticator({
      jwt: {
        audience: memoryAudience,
        issuer: memoryIssuer,
        ...(environment[TENANCY_API_ENV.memoryJwksUri]?.trim()
          ? { jwksUri: environment[TENANCY_API_ENV.memoryJwksUri]!.trim() }
          : {}),
      },
    }),
    ...(deviceAuthorizationClientId && deviceAuthorizationIssuer
      ? {
          deviceAuthorization: createDeviceAuthorizationService({
            ...deviceAuthorizationProviderProfile,
            clientId: deviceAuthorizationClientId,
            issuer: deviceAuthorizationIssuer,
          }),
        }
      : {}),
    idempotency,
    openApiSpec: () =>
      makePublicOpenApiSpec({
        includeAgentEmail:
          environment[TENANCY_API_ENV.agentEmailApiEnabled]?.trim().toLowerCase() === "true",
      }),
    operationalReads: createOperationalReadService({ cursorCodec, database }),
    recordApiCredentialUsage,
    service: {
      ...adaptTenancyPersistence(persistence),
      ...makeControlResourceApiServices({ database }),
      organizationLimits: makeOrganizationLimitsApiService({ database, environment }),
      organizationStanding: makeOrganizationStandingApiService({ database, environment }),
    },
  });
  const directory = makeDirectory({ database });
  const features = planFeaturesFromEnvironment({ database, environment });
  const routeFamilies = [
    createScimApi({ directory, gate }),
    createDirectoryApi({ authenticate, directory, features, idempotency }),
    identityFederationApiFromEnvironment({
      authenticate,
      database,
      environment,
      features,
      idempotency,
      identityIssuer: jwt.issuer,
    }),
    modelCredentialsApiFromEnvironment({ authenticate, database, environment, idempotency }),
    egressAllowlistApiFromEnvironment({ authenticate, database, idempotency }),
    organizationSpendApiFromEnvironment({ authenticate, database, environment }),
    appsApiFromEnvironment({
      authenticate,
      database,
      environment,
      idempotency,
      tenancy: persistence,
    }),
  ].filter((family) => family !== undefined);
  return async (request: Request) => {
    for (const family of routeFamilies) {
      const response = await family(request);
      if (response) return response;
    }
    return tenancy(request);
  };
});
