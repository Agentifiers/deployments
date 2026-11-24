import { Schema } from "effect";
import { Cursor, PUBLIC_ID_PATTERN_SOURCE, PublicId, Slug, Timestamp } from "./primitives.ts";
import type {
  PublicApiPathParameter,
  PublicApiQueryParameter,
  PublicApiRouteContract,
} from "./route-contract.ts";
import {
  ClearSystemOrganizationDataBoundaryRequest,
  ListSystemOrganizationStandingHistoryResponse,
  PlaceSystemOrganizationHoldRequest,
  ReleaseSystemOrganizationHoldRequest,
  ReplaceSystemOrganizationEntitlementsRequest,
  SetSystemOrganizationDataBoundaryRequest,
  STANDING_NAME_PATTERN_SOURCE,
  SystemOrganizationStandingChangeResponse,
  SystemOrganizationStandingResponse,
} from "./organization-standing.ts";
import { spendMonthParameter, SystemOrganizationSpendResponse } from "./organization-spend.ts";
import {
  ReplaceSystemPrincipalStatusRequest,
  SystemPrincipalStatusResponse,
} from "./principal-status.ts";
import {
  CloseSystemOrganizationAccessResponse,
  GetSystemOrganizationAccessResponse,
  ListSystemOperatorAccessResponse,
  OpenSystemOrganizationAccessRequest,
  OpenSystemOrganizationAccessResponse,
} from "./operator-access.ts";
import { SYSTEM_PRINCIPAL_API_SCHEMAS } from "./system-principals.ts";

const Sha256Hex = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/u)));
const ComponentHealth = Schema.Literals(["degraded", "healthy", "unavailable"]);
export const SYSTEM_ALARM_STATES = ["ALARM", "INSUFFICIENT_DATA", "OK"] as const;
export const SYSTEM_MODEL_PROVIDERS = ["bedrock", "openai", "openrouter"] as const;

const InstallationSnapshotFields = {
  awsAccountId: Schema.String,
  awsRegion: Schema.String,
  deployedAt: Timestamp,
  deployedBy: Schema.String,
  endpoints: Schema.Array(Schema.Struct({ name: Schema.String, url: Schema.String })),
  images: Schema.Array(
    Schema.Struct({ imageId: Schema.String, name: Schema.String, uri: Schema.String }),
  ),
  lambdaArtifacts: Schema.Array(
    Schema.Struct({
      functions: Schema.Array(Schema.Struct({ codeSha256: Sha256Hex, name: Schema.String })),
      name: Schema.String,
      sha256: Sha256Hex,
    }),
  ),
  profile: Schema.String,
  releaseManifestSha256: Sha256Hex,
  sourceCommit: Schema.String,
  targetName: Schema.String,
} as const;

export const SystemObservabilityDataLocations = Schema.Struct({
  athenaWorkgroup: Schema.NullOr(Schema.String),
  historyRetentionDays: Schema.NullOr(Schema.Number),
  hotPlane: Schema.Struct({ spanRetentionDays: Schema.Number, traceRetentionDays: Schema.Number }),
  tableBucket: Schema.NullOr(Schema.String),
  tableNamespace: Schema.NullOr(Schema.String),
});

export const SystemInstallationResponse = Schema.Struct({
  ...InstallationSnapshotFields,
  deploymentId: PublicId,
  observability: SystemObservabilityDataLocations,
  updatedAt: Timestamp,
  version: Schema.Number,
});

export const SystemInstallationDeploymentResponse = Schema.Struct({
  ...InstallationSnapshotFields,
  id: PublicId,
});

export const ListSystemInstallationDeploymentsResponse = Schema.Struct({
  items: Schema.Array(SystemInstallationDeploymentResponse),
  nextCursor: Schema.NullOr(Cursor),
});

export const SystemEcsServiceComponent = Schema.Struct({
  clusterName: Schema.String,
  component: Schema.String,
  desiredCount: Schema.NullOr(Schema.Number),
  health: ComponentHealth,
  pendingCount: Schema.NullOr(Schema.Number),
  rolloutState: Schema.NullOr(Schema.String),
  rolloutStateReason: Schema.NullOr(Schema.String),
  runningCount: Schema.NullOr(Schema.Number),
  serviceName: Schema.String,
  status: Schema.NullOr(Schema.String),
  taskDefinition: Schema.NullOr(Schema.String),
});

export const SystemLambdaFunctionComponent = Schema.Struct({
  artifact: Schema.String,
  codeMatchesRelease: Schema.NullOr(Schema.Boolean),
  codeSha256: Schema.NullOr(Sha256Hex),
  functionName: Schema.String,
  health: ComponentHealth,
  lastModified: Schema.NullOr(Schema.String),
  lastUpdateStatus: Schema.NullOr(Schema.String),
  state: Schema.NullOr(Schema.String),
});

export const SystemComponentsResponse = Schema.Struct({
  checkedAt: Timestamp,
  ecsServices: Schema.Array(SystemEcsServiceComponent),
  lambdaFunctions: Schema.Array(SystemLambdaFunctionComponent),
});

export const SystemAlarmResponse = Schema.Struct({
  metricName: Schema.NullOr(Schema.String),
  name: Schema.String,
  namespace: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  state: Schema.Literals(SYSTEM_ALARM_STATES),
  updatedAt: Schema.NullOr(Timestamp),
});

export const ListSystemAlarmsResponse = Schema.Struct({
  items: Schema.Array(SystemAlarmResponse),
  nextCursor: Schema.NullOr(Cursor),
});

/**
 * `task-role` (Bedrock) has no stored key: the model runtime task role holds Bedrock access
 * whenever Bedrock is hosted, so it is always configured and has no version.
 */
export const SystemModelProviderResponse = Schema.Struct({
  configured: Schema.Boolean,
  credentialStore: Schema.Literals(["secrets-manager", "ssm-parameter", "task-role"]),
  lastModifiedAt: Schema.NullOr(Timestamp),
  provider: Schema.Literals(SYSTEM_MODEL_PROVIDERS),
  version: Schema.NullOr(Schema.String),
});

export const ListSystemModelProvidersResponse = Schema.Struct({
  items: Schema.Array(SystemModelProviderResponse),
});

export const SystemOrganizationResponse = Schema.Struct({
  activeMemberCount: Schema.Number,
  createdAt: Timestamp,
  id: PublicId,
  name: Schema.String,
  slug: Slug,
  status: Schema.Literals(["active", "archived", "disabled"]),
  updatedAt: Timestamp,
});

export const ListSystemOrganizationsResponse = Schema.Struct({
  items: Schema.Array(SystemOrganizationResponse),
  nextCursor: Schema.NullOr(Cursor),
});

export const SYSTEM_OPERATOR_API_SCHEMAS = {
  ClearSystemOrganizationDataBoundaryRequest,
  ListSystemAlarmsResponse,
  ListSystemInstallationDeploymentsResponse,
  ListSystemModelProvidersResponse,
  ListSystemOrganizationStandingHistoryResponse,
  ListSystemOrganizationsResponse,
  PlaceSystemOrganizationHoldRequest,
  ReleaseSystemOrganizationHoldRequest,
  ReplaceSystemOrganizationEntitlementsRequest,
  ReplaceSystemPrincipalStatusRequest,
  SetSystemOrganizationDataBoundaryRequest,
  SystemComponentsResponse,
  SystemInstallationResponse,
  SystemOrganizationSpendResponse,
  SystemOrganizationStandingChangeResponse,
  SystemOrganizationStandingResponse,
  SystemPrincipalStatusResponse,
  CloseSystemOrganizationAccessResponse,
  GetSystemOrganizationAccessResponse,
  ListSystemOperatorAccessResponse,
  OpenSystemOrganizationAccessRequest,
  OpenSystemOrganizationAccessResponse,
  ...SYSTEM_PRINCIPAL_API_SCHEMAS,
} as const;

type SystemOperatorRouteInput = Omit<
  PublicApiRouteContract,
  | "authentication"
  | "errors"
  | "idempotency"
  | "method"
  | "requiredAuthorization"
  | "scopeHeaders"
  | "successStatus"
  | "tag"
>;

const systemOperatorAccess = {
  authentication: "tenant-jwt",
  idempotency: "none",
  requiredAuthorization: "platform:admin",
  scopeHeaders: "none",
  successStatus: 200,
  tag: "System",
} as const;

function systemOperatorRoute<const Route extends SystemOperatorRouteInput>(route: Route) {
  return {
    ...systemOperatorAccess,
    errors: [400, 401, 403, 404, 500, 503] as const,
    method: "GET" as const,
    ...route,
  };
}

function systemOperatorWrite<
  const Method extends "DELETE" | "POST" | "PUT",
  const Route extends SystemOperatorRouteInput,
>(method: Method, route: Route) {
  return {
    ...systemOperatorAccess,
    errors: [400, 401, 403, 404, 409, 500, 503] as const,
    method,
    ...route,
  };
}

const pageParameters = [
  { name: "cursor", schema: { maxLength: 4_096, minLength: 1, type: "string" } },
  { name: "limit", schema: { maximum: 100, minimum: 1, type: "integer" } },
] as const satisfies readonly PublicApiQueryParameter[];

const organizationStandingPath = "/v1/system/organizations/:organizationId/standing";
const organizationAccessPath = "/v1/system/organizations/:organizationId/operator-access";
const organizationAccessParameters = [
  {
    description: "Organization whose data the caller needs operator access to.",
    name: "organizationId",
    schema: { pattern: PUBLIC_ID_PATTERN_SOURCE, type: "string" },
  },
] as const satisfies readonly PublicApiPathParameter[];
const organizationHoldPath = "/v1/system/organizations/:organizationId/holds/:holdKey";
const organizationEntitlementsPath = "/v1/system/organizations/:organizationId/entitlements";
const organizationDataBoundaryPath = "/v1/system/organizations/:organizationId/data-boundary";
const standingParameters = [
  {
    description: "Organization whose standing to read or change.",
    name: "organizationId",
    schema: { pattern: PUBLIC_ID_PATTERN_SOURCE, type: "string" },
  },
] as const satisfies readonly PublicApiPathParameter[];
const holdParameters = [
  ...standingParameters,
  {
    description: "The caller's name for the hold, unique among the holds its source places.",
    name: "holdKey",
    schema: { pattern: STANDING_NAME_PATTERN_SOURCE, type: "string" },
  },
] as const satisfies readonly PublicApiPathParameter[];

const principalParameters = [
  {
    description: "The person's principal ID.",
    name: "principalId",
    schema: { pattern: PUBLIC_ID_PATTERN_SOURCE, type: "string" },
  },
] as const satisfies readonly PublicApiPathParameter[];

export const SYSTEM_OPERATOR_API_ROUTES = [
  systemOperatorRoute({
    name: "getSystemInstallation",
    path: "/v1/system/installation",
    responseBody: "SystemInstallationResponse",
  }),
  systemOperatorRoute({
    name: "listSystemDeployments",
    path: "/v1/system/deployments",
    queryParameters: pageParameters,
    responseBody: "ListSystemInstallationDeploymentsResponse",
  }),
  systemOperatorRoute({
    name: "getSystemComponents",
    path: "/v1/system/components",
    responseBody: "SystemComponentsResponse",
  }),
  systemOperatorRoute({
    name: "listSystemAlarms",
    path: "/v1/system/alarms",
    queryParameters: [
      ...pageParameters,
      {
        description: "Only alarms currently in this state.",
        name: "state",
        schema: { enum: SYSTEM_ALARM_STATES, type: "string" },
      },
    ],
    responseBody: "ListSystemAlarmsResponse",
  }),
  systemOperatorRoute({
    name: "listSystemModelProviders",
    path: "/v1/system/model-providers",
    responseBody: "ListSystemModelProvidersResponse",
  }),
  systemOperatorRoute({
    name: "listSystemOrganizations",
    path: "/v1/system/organizations",
    queryParameters: pageParameters,
    responseBody: "ListSystemOrganizationsResponse",
  }),
  systemOperatorRoute({
    name: "getSystemOrganizationStanding",
    path: organizationStandingPath,
    pathParameters: standingParameters,
    responseBody: "SystemOrganizationStandingResponse",
  }),
  systemOperatorRoute({
    name: "listSystemOrganizationStandingHistory",
    path: `${organizationStandingPath}/history`,
    pathParameters: standingParameters,
    queryParameters: pageParameters,
    responseBody: "ListSystemOrganizationStandingHistoryResponse",
  }),
  systemOperatorRoute({
    name: "getSystemOrganizationSpend",
    path: "/v1/system/organizations/:organizationId/spend",
    pathParameters: [
      {
        description: "Organization whose spend to read.",
        name: "organizationId",
        schema: { pattern: PUBLIC_ID_PATTERN_SOURCE, type: "string" },
      },
    ],
    queryParameters: [spendMonthParameter],
    responseBody: "SystemOrganizationSpendResponse",
  }),
  systemOperatorWrite("PUT", {
    name: "placeSystemOrganizationHold",
    path: organizationHoldPath,
    pathParameters: holdParameters,
    requestBody: "PlaceSystemOrganizationHoldRequest",
    responseBody: "SystemOrganizationStandingChangeResponse",
  }),
  systemOperatorWrite("DELETE", {
    name: "releaseSystemOrganizationHold",
    path: organizationHoldPath,
    pathParameters: holdParameters,
    requestBody: "ReleaseSystemOrganizationHoldRequest",
    requestBodyRequired: false,
    responseBody: "SystemOrganizationStandingChangeResponse",
  }),
  systemOperatorWrite("PUT", {
    name: "replaceSystemOrganizationEntitlements",
    path: organizationEntitlementsPath,
    pathParameters: standingParameters,
    requestBody: "ReplaceSystemOrganizationEntitlementsRequest",
    responseBody: "SystemOrganizationStandingChangeResponse",
  }),
  systemOperatorWrite("DELETE", {
    name: "clearSystemOrganizationEntitlements",
    path: organizationEntitlementsPath,
    pathParameters: standingParameters,
    responseBody: "SystemOrganizationStandingChangeResponse",
  }),
  systemOperatorWrite("PUT", {
    name: "setSystemOrganizationDataBoundary",
    path: organizationDataBoundaryPath,
    pathParameters: standingParameters,
    requestBody: "SetSystemOrganizationDataBoundaryRequest",
    responseBody: "SystemOrganizationStandingChangeResponse",
  }),
  systemOperatorWrite("DELETE", {
    name: "clearSystemOrganizationDataBoundary",
    path: organizationDataBoundaryPath,
    pathParameters: standingParameters,
    requestBody: "ClearSystemOrganizationDataBoundaryRequest",
    responseBody: "SystemOrganizationStandingChangeResponse",
  }),
  systemOperatorWrite("PUT", {
    name: "replaceSystemPrincipalStatus",
    path: "/v1/system/principals/:principalId/status",
    pathParameters: [
      {
        description: "The person whose status to change.",
        name: "principalId",
        schema: { pattern: PUBLIC_ID_PATTERN_SOURCE, type: "string" },
      },
    ],
    requestBody: "ReplaceSystemPrincipalStatusRequest",
    responseBody: "SystemPrincipalStatusResponse",
  }),
  systemOperatorRoute({
    name: "getSystemOrganizationAccess",
    path: organizationAccessPath,
    pathParameters: organizationAccessParameters,
    responseBody: "GetSystemOrganizationAccessResponse",
  }),
  systemOperatorWrite("PUT", {
    name: "openSystemOrganizationAccess",
    path: organizationAccessPath,
    pathParameters: organizationAccessParameters,
    requestBody: "OpenSystemOrganizationAccessRequest",
    responseBody: "OpenSystemOrganizationAccessResponse",
  }),
  systemOperatorWrite("DELETE", {
    name: "closeSystemOrganizationAccess",
    path: organizationAccessPath,
    pathParameters: organizationAccessParameters,
    responseBody: "CloseSystemOrganizationAccessResponse",
  }),
  systemOperatorRoute({
    name: "listSystemOperatorAccess",
    path: "/v1/system/operator-access",
    queryParameters: [
      ...pageParameters,
      {
        description: "Only open access to this organization.",
        name: "organizationId",
        schema: { pattern: PUBLIC_ID_PATTERN_SOURCE, type: "string" },
      },
    ],
    responseBody: "ListSystemOperatorAccessResponse",
  }),
  systemOperatorRoute({
    name: "findSystemPrincipal",
    path: "/v1/system/principals",
    queryParameters: [
      {
        description: "The person's email. Matches the whole normalized address only.",
        name: "email",
        required: true,
        schema: { maxLength: 320, minLength: 3, type: "string" },
      },
    ],
    responseBody: "FindSystemPrincipalResponse",
  }),
  systemOperatorRoute({
    name: "getSystemPrincipal",
    path: "/v1/system/principals/:principalId",
    pathParameters: principalParameters,
    responseBody: "SystemPrincipalResponse",
  }),
  systemOperatorRoute({
    name: "listSystemPrincipalSecurityEvents",
    path: "/v1/system/principals/:principalId/security-events",
    pathParameters: principalParameters,
    queryParameters: pageParameters,
    responseBody: "ListSystemPrincipalSecurityEventsResponse",
  }),
  systemOperatorWrite("POST", {
    name: "revokeSystemPrincipalSessions",
    path: "/v1/system/principals/:principalId/sessions/revoke",
    pathParameters: principalParameters,
    requestBody: "RevokeSystemPrincipalSessionsRequest",
    responseBody: "SystemPrincipalSessionsRevokedResponse",
  }),
  {
    ...systemOperatorWrite("POST", {
      name: "resendSystemPrincipalVerification",
      path: "/v1/system/principals/:principalId/verification-email",
      pathParameters: principalParameters,
      requestBody: "ResendSystemPrincipalVerificationRequest",
      responseBody: "SystemPrincipalVerificationSentResponse",
    }),
    errors: [400, 401, 403, 404, 409, 429, 500, 503] as const,
  },
] as const satisfies readonly PublicApiRouteContract[];

export type SystemOperatorRouteName = (typeof SYSTEM_OPERATOR_API_ROUTES)[number]["name"];

export const SYSTEM_SERVICE_GRANTS = [
  "organization-read",
  "organization-holds",
  "organization-entitlements",
] as const;
export type SystemServiceGrant = (typeof SYSTEM_SERVICE_GRANTS)[number];

export const SYSTEM_SERVICE_PATH_PREFIX = "/v1/system/services";

/**
 * The system operations a machine service may call, each with the grant its principal needs. A
 * service signs `/v1/system/services/<rest>` with SigV4 to call the operation at
 * `/v1/system/<rest>`; its holds and grant belong to source `service:<name>`.
 */
export const SYSTEM_SERVICE_OPERATION_GRANTS = {
  clearSystemOrganizationEntitlements: "organization-entitlements",
  getSystemOrganizationSpend: "organization-read",
  getSystemOrganizationStanding: "organization-read",
  listSystemOrganizationStandingHistory: "organization-read",
  placeSystemOrganizationHold: "organization-holds",
  releaseSystemOrganizationHold: "organization-holds",
  replaceSystemOrganizationEntitlements: "organization-entitlements",
} as const satisfies Partial<Record<SystemOperatorRouteName, SystemServiceGrant>>;

export type SystemServiceRouteName = keyof typeof SYSTEM_SERVICE_OPERATION_GRANTS;

export function systemServicePath(operatorPath: string) {
  return `${SYSTEM_SERVICE_PATH_PREFIX}${operatorPath.slice("/v1/system".length)}`;
}

type CustomerDataRouteName =
  | "getSystemOrganizationAccess"
  | "listSystemOperatorAccess"
  | "getSystemOrganizationSpend"
  | "getSystemOrganizationStanding"
  | "listSystemOrganizationStandingHistory"
  | "listSystemOrganizations";

type SystemObservableRouteName = Exclude<
  Extract<(typeof SYSTEM_OPERATOR_API_ROUTES)[number], { readonly method: "GET" }>["name"],
  CustomerDataRouteName
>;

/**
 * IAM-authorized reads of the install for a machine reader in AWS, such as an operations
 * account's monitoring. Each one serves the `GET` system route it names with the same query
 * parameters and response body.
 */
export const SYSTEM_OBSERVER_ROUTES = [
  { method: "GET", path: "/v1/system/observer/installation", serves: "getSystemInstallation" },
  { method: "GET", path: "/v1/system/observer/deployments", serves: "listSystemDeployments" },
  { method: "GET", path: "/v1/system/observer/components", serves: "getSystemComponents" },
  { method: "GET", path: "/v1/system/observer/alarms", serves: "listSystemAlarms" },
  {
    method: "GET",
    path: "/v1/system/observer/model-providers",
    serves: "listSystemModelProviders",
  },
] as const satisfies readonly {
  readonly method: "GET";
  readonly path: `/v1/system/observer/${string}`;
  readonly serves: SystemObservableRouteName;
}[];
