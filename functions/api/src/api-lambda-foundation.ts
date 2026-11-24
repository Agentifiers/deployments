import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { PUBLIC_API_ROUTES } from "@deployments-ai/api-contract/product";
import {
  createApiCredentialUsageRecorder,
  makeDynamoDatabase,
  makeIdempotencyPersistence,
  makeKmsIdempotencyResponseProtector,
  tableNamesFromEnvironment,
  type ApiCredentialUsageRecorder,
  type DynamoDatabaseService,
  type TableNames,
} from "@deployments-ai/db";
import {
  parsePlatformJwtAudience,
  parsePlatformJwtClaimProfile,
  type JwtAuthenticationOptions,
} from "@deployments-ai/identity/platform-jwt";
import { parseModelOperatorGrantsJson } from "@deployments-ai/model-gateway";
import { loadAwsSecretString } from "@deployments-ai/secret-store";
import {
  apiRequestClassifier,
  makeOrganizationGateFromEnvironment,
  organizationRefusalResponse,
  type OrganizationGate,
} from "@deployments-ai/organization-admission";
import { chargedOrganization } from "@deployments-ai/tenant-limits";
import type { ApiIdentity } from "./api-service-contracts.ts";
import {
  createApplicationAuthenticator,
  OperatorAccessRequiredError,
  OrganizationSsoRequiredError,
} from "./application-auth.ts";
import { requiredEnvironment } from "./lambda-environment.ts";
import { createHttpApiV2Handler, type HttpApiV2Event, type HttpApiV2Result } from "./lambda.ts";

export const API_ENV = {
  artifactBucket: "DEPLOYMENTS_AI_ARTIFACT_BUCKET",
  artifactKmsKeyArn: "DEPLOYMENTS_AI_ARTIFACT_KMS_KEY_ARN",
  idempotencyKmsKeyArn: "DEPLOYMENTS_AI_API_IDEMPOTENCY_KMS_KEY_ARN",
  jwtAudience: "DEPLOYMENTS_AI_API_JWT_AUDIENCE",
  jwtClaimProfile: "DEPLOYMENTS_AI_API_JWT_CLAIM_PROFILE",
  jwtIssuer: "DEPLOYMENTS_AI_API_JWT_ISSUER",
  jwksUri: "DEPLOYMENTS_AI_API_JWKS_URI",
  modelGrantsParameterArn: "DEPLOYMENTS_AI_MODEL_GRANTS_PARAMETER_ARN",
} as const;

export interface ApiFoundation {
  readonly authenticate: (request: Request) => Promise<ApiIdentity | null>;
  readonly database: DynamoDatabaseService;
  readonly documentClient: DynamoDBDocumentClient;
  readonly jwt: JwtAuthenticationOptions;
  readonly recordApiCredentialUsage: ApiCredentialUsageRecorder;
  readonly tableNames: TableNames;
}

export function makeApiFoundation(environment: NodeJS.ProcessEnv): ApiFoundation {
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const tableNames = tableNamesFromEnvironment(environment);
  const database = makeDynamoDatabase(documentClient, tableNames);
  const claimProfile = parsePlatformJwtClaimProfile(environment[API_ENV.jwtClaimProfile]);
  const jwt = {
    audience: parsePlatformJwtAudience(requiredEnvironment(environment, API_ENV.jwtAudience)),
    ...(claimProfile ? { claimProfile } : {}),
    issuer: requiredEnvironment(environment, API_ENV.jwtIssuer),
    ...(environment[API_ENV.jwksUri]?.trim()
      ? { jwksUri: environment[API_ENV.jwksUri]!.trim() }
      : {}),
  };
  return {
    authenticate: createApplicationAuthenticator({ database, jwt }),
    database,
    documentClient,
    jwt,
    recordApiCredentialUsage: createApiCredentialUsageRecorder({ database }),
    tableNames,
  };
}

export function makeApiIdempotency(input: {
  readonly database: DynamoDatabaseService;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const responseProtector = makeKmsIdempotencyResponseProtector({
    kmsKeyArn: requiredEnvironment(input.environment, API_ENV.idempotencyKmsKeyArn),
  });
  return {
    idempotency: makeIdempotencyPersistence({ database: input.database, responseProtector }),
    responseProtector,
  };
}

export function freshModelOperatorGrants(environment: NodeJS.ProcessEnv) {
  const parameterArn = environment[API_ENV.modelGrantsParameterArn]?.trim();
  return parameterArn
    ? async () => parseModelOperatorGrantsJson(await loadAwsSecretString(parameterArn))
    : undefined;
}

function problemResponse(problem: {
  readonly code: string;
  readonly extensions?: Readonly<Record<string, string>>;
  readonly status: number;
  readonly title: string;
}) {
  const requestId = `req_${randomUUID()}`;
  const body = JSON.stringify({
    type: `https://docs.deployments.ai/errors/${problem.code.replaceAll("_", "-")}`,
    title: problem.title,
    status: problem.status,
    code: problem.code,
    ...problem.extensions,
    requestId,
  });
  return new Response(body, {
    headers: {
      "content-length": String(Buffer.byteLength(body)),
      "content-type": "application/problem+json",
      "x-request-id": requestId,
    },
    status: problem.status,
  });
}

const ROUTE_NOT_FOUND = {
  code: "route_not_found",
  status: 404,
  title: "The requested API route does not exist.",
} as const;

export interface ApiLambdaDependencies {
  readonly foundation: ApiFoundation;
  readonly gate: OrganizationGate;
}

function apiLambdaDependencies(environment: NodeJS.ProcessEnv): ApiLambdaDependencies {
  const foundation = makeApiFoundation(environment);
  return {
    foundation,
    gate: makeOrganizationGateFromEnvironment({
      client: foundation.documentClient,
      database: foundation.database,
      environment,
    }),
  };
}

const classifyApiRequest = apiRequestClassifier(PUBLIC_API_ROUTES);

function authenticateOncePerRequest(authenticate: ApiFoundation["authenticate"]) {
  const identities = new WeakMap<Request, Promise<ApiIdentity | null>>();
  return (request: Request) => {
    let identity = identities.get(request);
    if (!identity) {
      identity = authenticate(request);
      identities.set(request, identity);
    }
    return identity;
  };
}

export function createApiLambdaHandler(
  createFetch: (
    foundation: ApiFoundation,
    environment: NodeJS.ProcessEnv,
    gate: OrganizationGate,
  ) => (request: Request) => Promise<Response | undefined>,
  options: {
    readonly dependencies?: (environment: NodeJS.ProcessEnv) => ApiLambdaDependencies;
    readonly enabled?: (environment: NodeJS.ProcessEnv) => boolean;
  } = {},
) {
  const createRuntime = (environment: NodeJS.ProcessEnv) => {
    if (options.enabled && !options.enabled(environment)) {
      return createHttpApiV2Handler(async () => problemResponse(ROUTE_NOT_FOUND));
    }
    const { foundation, gate } = (options.dependencies ?? apiLambdaDependencies)(environment);
    const authenticate = authenticateOncePerRequest(foundation.authenticate);
    const fetch = createFetch({ ...foundation, authenticate }, environment, gate);
    return createHttpApiV2Handler(async (request) => {
      const identity = await authenticate(request).catch((cause: unknown) =>
        cause instanceof OrganizationSsoRequiredError ||
        cause instanceof OperatorAccessRequiredError
          ? cause
          : null,
      );
      if (identity instanceof OrganizationSsoRequiredError) {
        return problemResponse({
          code: "organization_sso_required",
          extensions: { organizationId: identity.organizationId },
          status: 403,
          title: identity.message,
        });
      }
      if (identity instanceof OperatorAccessRequiredError) {
        return problemResponse({
          code: "operator_access_required",
          extensions: { detail: identity.message, organizationId: identity.organizationId },
          status: 403,
          title: "Operator access required",
        });
      }
      const organizationId = chargedOrganization(identity?.organizationIds);
      if (organizationId) {
        const decision = await gate.admit(
          organizationId,
          classifyApiRequest(request.method, new URL(request.url).pathname),
        );
        if (decision.kind !== "admitted") {
          return organizationRefusalResponse(decision, `req_${randomUUID()}`);
        }
      }
      return (await fetch(request)) ?? problemResponse(ROUTE_NOT_FOUND);
    });
  };
  let runtime: ((event: HttpApiV2Event) => Promise<HttpApiV2Result>) | undefined;
  return async (event: HttpApiV2Event): Promise<HttpApiV2Result> => {
    runtime ??= createRuntime(process.env);
    return runtime(event);
  };
}
