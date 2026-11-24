import { resolveTxt } from "node:dns/promises";
import { IDENTITY_FEDERATION_API_ROUTES } from "@deployments-ai/api-contract";
import {
  makeIdentityFederationAdministration,
  makeKmsEnvelopeAdapter,
  type DynamoDatabaseService,
  type IdempotencyPersistence,
} from "@deployments-ai/db";
import { FederationError, pinnedFederationHttp } from "@deployments-ai/identity";
import type { ApiIdentity } from "./api-service-contracts.ts";
import {
  makeIdentityFederationOperations,
  type IdentityFederationOperationDependencies,
} from "./identity-federation-operations.ts";
import { requiredEnvironment } from "./lambda-environment.ts";
import {
  OrganizationAdminProblem,
  createOrganizationAdminApi,
  type OrganizationAdminApiOptions,
} from "./organization-admin-api.ts";

export const IDENTITY_FEDERATION_ENV = {
  kmsKeyId: "DEPLOYMENTS_AI_IDENTITY_FEDERATION_KMS_KEY_ID",
  stage: "DEPLOYMENTS_AI_STAGE",
} as const;

export type CreateIdentityFederationApiOptions = IdentityFederationOperationDependencies &
  OrganizationAdminApiOptions;

export function createIdentityFederationApi(options: CreateIdentityFederationApiOptions) {
  const operate = makeIdentityFederationOperations(options);
  return createOrganizationAdminApi(
    {
      label: "Identity federation",
      operate: async (routeName, invocation) => {
        try {
          return await operate(routeName, invocation);
        } catch (cause) {
          if (cause instanceof FederationError) {
            throw new OrganizationAdminProblem(422, cause.code, cause.message);
          }
          throw cause;
        }
      },
      routes: IDENTITY_FEDERATION_API_ROUTES,
    },
    options,
  );
}

export function identityFederationApiFromEnvironment(input: {
  readonly authenticate: (request: Request) => Promise<ApiIdentity | null>;
  readonly database: DynamoDatabaseService;
  readonly environment: NodeJS.ProcessEnv;
  readonly features: NonNullable<OrganizationAdminApiOptions["features"]>;
  readonly idempotency: Pick<IdempotencyPersistence, "execute">;
  readonly identityIssuer: string;
}) {
  const keyId = input.environment[IDENTITY_FEDERATION_ENV.kmsKeyId]?.trim();
  if (!keyId) return undefined;
  return createIdentityFederationApi({
    administration: makeIdentityFederationAdministration({ database: input.database }),
    authenticate: input.authenticate,
    features: input.features,
    federationHttp: pinnedFederationHttp(),
    idempotency: input.idempotency,
    identityIssuer: input.identityIssuer,
    resolveTxt,
    secrets: makeKmsEnvelopeAdapter({
      keyId,
      stage: requiredEnvironment(input.environment, IDENTITY_FEDERATION_ENV.stage),
    }),
  });
}
