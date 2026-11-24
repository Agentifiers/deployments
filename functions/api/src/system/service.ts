import type { SystemOperatorRouteName } from "@deployments-ai/api-contract/system";
import {
  StandingActor,
  type InstallationDeployment,
  type InstallationRepository,
  type PlatformOrganizationDirectory,
  type ServiceName,
} from "@deployments-ai/db";
import { HOT_PLANE_RETENTION_DAYS } from "@deployments-ai/observability";
import { Schema } from "effect";
import type { SystemOperatorConfiguration } from "./configuration.ts";
import type { SystemOperatorAccess } from "./operator-access.ts";
import type { SystemOrganizationSpend } from "./organization-spend.ts";
import type { SystemOrganizationStanding } from "./organization-standing.ts";
import type { SystemPrincipalStatus } from "./principal-status.ts";
import type { SystemPrincipals } from "./principals.ts";
import type {
  EcsServiceObservation,
  LambdaFunctionObservation,
  SystemAwsReaders,
} from "./readers.ts";

const PLACEHOLDER_PARAMETER_VERSION = 1;

export class SystemOperatorProblem extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 429 | 503,
    readonly code: string,
    message: string,
    readonly extensions: Readonly<Record<string, string>> = {},
  ) {
    super(message);
  }
}

export function parseBody<T>(decode: (input: unknown) => T, body: unknown): T {
  try {
    return decode(body);
  } catch (cause) {
    throw new SystemOperatorProblem(
      400,
      "invalid_request",
      cause instanceof Error ? cause.message : "The request body does not match the contract.",
    );
  }
}

export interface SystemOperatorQuery {
  readonly cursor?: string;
  readonly email?: string;
  readonly limit?: number;
  readonly month?: string;
  readonly state?: "ALARM" | "INSUFFICIENT_DATA" | "OK";
  readonly organizationId?: string;
}

/** Who the system API authenticated. Observers reach only the observer reads. */
export type SystemCaller =
  | { readonly kind: "observer" }
  | { readonly kind: "operator"; readonly principalId: string }
  | { readonly kind: "service"; readonly service: ServiceName };

export interface SystemOperatorRequest {
  readonly body: unknown;
  readonly caller: SystemCaller;
  readonly params: Readonly<Record<string, string>>;
  readonly query: SystemOperatorQuery;
}

export interface SystemOperatorServiceDependencies {
  readonly configuration: SystemOperatorConfiguration | undefined;
  /** Why the OpenTofu configuration was rejected; the operator routes answer 503 with it. */
  readonly configurationError?: string;
  readonly installations: InstallationRepository;
  readonly now?: () => Date;
  readonly operatorAccess: SystemOperatorAccess;
  readonly organizationSpend: SystemOrganizationSpend;
  readonly organizationStanding: SystemOrganizationStanding;
  readonly organizations: PlatformOrganizationDirectory;
  readonly principalStatus: SystemPrincipalStatus;
  readonly principals: SystemPrincipals;
  readonly readers: SystemAwsReaders;
}

export type SystemOperatorService = (
  route: SystemOperatorRouteName,
  request: SystemOperatorRequest,
) => Promise<unknown>;

function pathParameter(request: SystemOperatorRequest, name: string) {
  const value = request.params[name];
  if (value === undefined) {
    throw new SystemOperatorProblem(404, "not_found", `The route has no ${name} parameter.`);
  }
  return value;
}

const decodeStandingActor = Schema.decodeUnknownSync(StandingActor);

function standingActor({ caller }: SystemOperatorRequest): StandingActor {
  if (caller.kind === "observer") {
    throw new SystemOperatorProblem(
      403,
      "system_observer_read_only",
      "Observer sessions only read installation status.",
    );
  }
  return decodeStandingActor(caller);
}

function operatorId({ caller }: SystemOperatorRequest) {
  if (caller.kind !== "operator") {
    throw new SystemOperatorProblem(
      403,
      "platform_administrator_required",
      "Only a platform administrator signed in through platform identity can make this change.",
    );
  }
  return caller.principalId;
}
type Health = "degraded" | "healthy" | "unavailable";

function deploymentSnapshot(deployment: Omit<InstallationDeployment, "createdAt" | "id">) {
  return {
    awsAccountId: deployment.awsAccountId,
    awsRegion: deployment.awsRegion,
    deployedAt: deployment.deployedAt,
    deployedBy: deployment.deployedBy,
    endpoints: deployment.endpoints,
    images: deployment.images,
    lambdaArtifacts: deployment.lambdaArtifacts,
    profile: deployment.profile,
    releaseManifestSha256: deployment.releaseManifestSha256,
    sourceCommit: deployment.sourceCommit,
    targetName: deployment.targetName,
  };
}

function ecsHealth(service: EcsServiceObservation | undefined): Health {
  if (!service || service.status !== "ACTIVE") return "unavailable";
  const desired = service.desiredCount ?? 0;
  const settled =
    (service.runningCount ?? 0) === desired &&
    (service.pendingCount ?? 0) === 0 &&
    (service.rolloutState === undefined || service.rolloutState === "COMPLETED");
  return settled ? "healthy" : "degraded";
}

function lambdaHealth(
  observation: LambdaFunctionObservation | undefined,
  codeMatchesRelease: boolean | null,
): Health {
  if (!observation) return "unavailable";
  return codeMatchesRelease === false ? "degraded" : "healthy";
}

/**
 * Operator reads over the installation record, the organization directory, and AWS metadata, plus
 * organization standing.
 */
export function makeSystemOperatorService(
  dependencies: SystemOperatorServiceDependencies,
): SystemOperatorService {
  const {
    configuration,
    installations,
    operatorAccess,
    organizationSpend,
    organizationStanding,
    organizations,
    principalStatus,
    principals,
    readers,
  } = dependencies;
  const now = dependencies.now ?? (() => new Date());

  function requireConfiguration() {
    if (dependencies.configurationError !== undefined) {
      throw new SystemOperatorProblem(
        503,
        "system_operator_misconfigured",
        dependencies.configurationError,
      );
    }
    if (!configuration) {
      throw new SystemOperatorProblem(
        503,
        "system_operator_unconfigured",
        "This install does not configure operator reads.",
      );
    }
    return configuration;
  }

  async function components() {
    const { ecsServices } = requireConfiguration();
    const clusters = new Map<string, string[]>();
    for (const [, clusterName, serviceName] of ecsServices) {
      clusters.set(clusterName, [...(clusters.get(clusterName) ?? []), serviceName]);
    }
    const observed = new Map<string, ReadonlyMap<string, EcsServiceObservation>>();
    await Promise.all(
      [...clusters].map(async ([clusterName, serviceNames]) => {
        observed.set(clusterName, await readers.describeEcsServices(clusterName, serviceNames));
      }),
    );
    const [installation, deployed] = await Promise.all([
      installations.current(),
      readers.listLambdaFunctions(),
    ]);
    const lambdaFunctions = (installation?.lambdaArtifacts ?? []).flatMap((artifact) =>
      artifact.functions.map((released) => {
        const observation = deployed.get(released.name);
        const codeMatchesRelease = observation?.codeSha256
          ? observation.codeSha256 === released.codeSha256
          : null;
        return {
          artifact: artifact.name,
          codeMatchesRelease,
          codeSha256: observation?.codeSha256 ?? null,
          functionName: released.name,
          health: lambdaHealth(observation, codeMatchesRelease),
          lastModified: observation?.lastModified ?? null,
          // ListFunctions does not return State or LastUpdateStatus.
          lastUpdateStatus: null,
          state: null,
        };
      }),
    );
    return {
      checkedAt: now().toISOString(),
      ecsServices: ecsServices.map(([component, clusterName, serviceName]) => {
        const service = observed.get(clusterName)?.get(serviceName);
        return {
          clusterName,
          component,
          desiredCount: service?.desiredCount ?? null,
          health: ecsHealth(service),
          pendingCount: service?.pendingCount ?? null,
          rolloutState: service?.rolloutState ?? null,
          rolloutStateReason: service?.rolloutStateReason ?? null,
          runningCount: service?.runningCount ?? null,
          serviceName,
          status: service?.status ?? null,
          taskDefinition: service?.taskDefinition ?? null,
        };
      }),
      lambdaFunctions,
    };
  }

  async function modelProviders() {
    const { bedrockRegion, modelProviderSecrets } = requireConfiguration();
    // Providers the install does not wire (no secret reference) are omitted.
    const providers = Object.entries(modelProviderSecrets)
      .filter((entry): entry is [keyof typeof modelProviderSecrets, string] => !!entry[1])
      .toSorted(([left], [right]) => left.localeCompare(right));
    const bedrock =
      bedrockRegion === null
        ? []
        : [
            {
              configured: true,
              credentialStore: "task-role" as const,
              lastModifiedAt: null,
              provider: "bedrock" as const,
              version: null,
            },
          ];
    return {
      items: [
        ...bedrock,
        ...(await Promise.all(
          providers.map(async ([provider, reference]) => {
            const metadata = await readers.describeSecret(reference);
            const credentialStore = reference.startsWith("arn:aws:secretsmanager:")
              ? ("secrets-manager" as const)
              : ("ssm-parameter" as const);
            if (!metadata) {
              return {
                configured: false,
                credentialStore,
                lastModifiedAt: null,
                provider,
                version: null,
              };
            }
            if (metadata.kind === "secrets-manager") {
              return {
                configured: metadata.currentVersionId !== undefined,
                credentialStore,
                lastModifiedAt: metadata.lastModifiedAt ?? null,
                provider,
                version: metadata.currentVersionId ?? null,
              };
            }
            return {
              configured: (metadata.version ?? 0) > PLACEHOLDER_PARAMETER_VERSION,
              credentialStore,
              lastModifiedAt: metadata.lastModifiedAt ?? null,
              provider,
              version: metadata.version === undefined ? null : String(metadata.version),
            };
          }),
        )),
      ],
    };
  }

  function standingWrite(request: SystemOperatorRequest) {
    return {
      actor: standingActor(request),
      body: request.body,
      organizationId: pathParameter(request, "organizationId"),
    };
  }

  return async (route, request) => {
    const { query } = request;
    switch (route) {
      case "getSystemInstallation": {
        const installation = await installations.current();
        if (!installation) {
          throw new SystemOperatorProblem(
            404,
            "installation_not_recorded",
            "No deployment has been recorded for this install yet.",
          );
        }
        const observability = configuration?.observability;
        return {
          ...deploymentSnapshot(installation),
          deploymentId: installation.deploymentId,
          observability: {
            athenaWorkgroup: observability?.athenaWorkgroup ?? null,
            historyRetentionDays: observability?.historyRetentionDays ?? null,
            hotPlane: {
              spanRetentionDays: HOT_PLANE_RETENTION_DAYS.span,
              traceRetentionDays: HOT_PLANE_RETENTION_DAYS.trace,
            },
            tableBucket: observability?.tableBucket ?? null,
            tableNamespace: observability?.tableNamespace ?? null,
          },
          updatedAt: installation.updatedAt,
          version: installation.version,
        };
      }
      case "listSystemDeployments": {
        const page = await installations.listDeployments(query);
        return {
          items: page.items.map((deployment) => ({
            ...deploymentSnapshot(deployment),
            id: deployment.id,
          })),
          nextCursor: page.nextCursor ?? null,
        };
      }
      case "getSystemComponents":
        return components();
      case "listSystemAlarms": {
        const { alarmNamePrefix } = requireConfiguration();
        const page = await readers.describeAlarms({
          maxRecords: query.limit ?? 100,
          ...(alarmNamePrefix ? { namePrefix: alarmNamePrefix } : {}),
          ...(query.cursor ? { nextToken: query.cursor } : {}),
          ...(query.state ? { state: query.state } : {}),
        });
        return {
          items: page.alarms.map((alarm) => ({
            metricName: alarm.metricName ?? null,
            name: alarm.name,
            namespace: alarm.namespace ?? null,
            reason: alarm.reason ?? null,
            state: alarm.state,
            updatedAt: alarm.updatedAt ?? null,
          })),
          nextCursor: page.nextToken ?? null,
        };
      }
      case "listSystemModelProviders":
        return modelProviders();
      case "listSystemOrganizations": {
        const page = await organizations.list(query);
        return {
          items: page.items,
          nextCursor: page.nextCursor ?? null,
        };
      }
      case "getSystemOrganizationSpend":
        return organizationSpend(pathParameter(request, "organizationId"), query.month);
      case "getSystemOrganizationStanding":
        return organizationStanding.read(pathParameter(request, "organizationId"));
      case "listSystemOrganizationStandingHistory":
        return organizationStanding.history({
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
          organizationId: pathParameter(request, "organizationId"),
        });
      case "placeSystemOrganizationHold":
        return organizationStanding.placeHold({
          ...standingWrite(request),
          holdKey: pathParameter(request, "holdKey"),
        });
      case "releaseSystemOrganizationHold":
        return organizationStanding.releaseHold({
          ...standingWrite(request),
          holdKey: pathParameter(request, "holdKey"),
        });
      case "replaceSystemOrganizationEntitlements":
        return organizationStanding.replaceEntitlements(standingWrite(request));
      case "clearSystemOrganizationEntitlements":
        return organizationStanding.clearEntitlements(standingWrite(request));
      case "setSystemOrganizationDataBoundary":
        return organizationStanding.setDataBoundary(standingWrite(request));
      case "clearSystemOrganizationDataBoundary":
        return organizationStanding.clearDataBoundary(standingWrite(request));
      case "replaceSystemPrincipalStatus":
        return principalStatus({
          body: request.body,
          operatorId: operatorId(request),
          principalId: pathParameter(request, "principalId"),
        });
      case "getSystemOrganizationAccess":
        return operatorAccess.get({
          operatorId: operatorId(request),
          organizationId: pathParameter(request, "organizationId"),
        });
      case "openSystemOrganizationAccess":
        return operatorAccess.open({
          body: request.body,
          operatorId: operatorId(request),
          organizationId: pathParameter(request, "organizationId"),
        });
      case "closeSystemOrganizationAccess":
        return operatorAccess.close({
          operatorId: operatorId(request),
          organizationId: pathParameter(request, "organizationId"),
        });
      case "listSystemOperatorAccess":
        operatorId(request);
        return operatorAccess.list(query);
      case "findSystemPrincipal":
        return principals.find(query.email);
      case "getSystemPrincipal":
        return principals.get(pathParameter(request, "principalId"));
      case "listSystemPrincipalSecurityEvents":
        return principals.securityEvents({
          cursor: query.cursor,
          limit: query.limit,
          principalId: pathParameter(request, "principalId"),
        });
      case "revokeSystemPrincipalSessions":
        return principals.revokeSessions({
          body: request.body,
          operatorId: operatorId(request),
          principalId: pathParameter(request, "principalId"),
        });
      case "resendSystemPrincipalVerification":
        return principals.resendVerification({
          body: request.body,
          operatorId: operatorId(request),
          principalId: pathParameter(request, "principalId"),
        });
    }
  };
}
