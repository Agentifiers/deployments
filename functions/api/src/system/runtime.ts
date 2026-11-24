import {
  makeInstallationRepository,
  makeOperatorAccessRepository,
  makeOrganizationEgressAllowlistReader,
  makeOrganizationStandingRepository,
  makePlatformOrganizationDirectory,
  makePlatformPrincipalDirectory,
  type DynamoDatabaseService,
} from "@deployments-ai/db";
import { parseInstallDefaultEntitlements } from "@deployments-ai/tenant-limits/install-defaults";
import type { ApiIdentity } from "../api-service-contracts.ts";
import type { LambdaInvoker } from "../observability-erasure.ts";
import { createSystemOperatorApi } from "./api.ts";
import { defaultSystemAwsClients, makeSystemAwsReaders } from "./aws-readers.ts";
import {
  loadSystemOperatorConfiguration,
  type SystemOperatorParameterStore,
} from "./configuration.ts";
import { parseSystemObserverRoles } from "./observer.ts";
import { makeSystemOperatorAccess } from "./operator-access.ts";
import { makeSystemOrganizationSpend } from "./organization-spend.ts";
import { makeSystemOrganizationStanding } from "./organization-standing.ts";
import { identityPrincipalStatus, makeSystemPrincipalStatus } from "./principal-status.ts";
import { identityPrincipalCommands, makeSystemPrincipals } from "./principals.ts";
import { parseSystemServicePrincipals } from "./service-principals.ts";
import { makeSystemOperatorService, type SystemOperatorService } from "./service.ts";

/**
 * Binds the operator routes to DynamoDB, the OpenTofu configuration parameter, and AWS metadata
 * reads. The first operator request of a cold start reads the parameter; an invalid or unreadable
 * configuration only disables the routes that need it and never fails the whole API.
 */
export function makeSystemOperatorFetch(input: {
  readonly authenticate: (request: Request) => Promise<ApiIdentity | null>;
  readonly database: DynamoDatabaseService;
  readonly environment: NodeJS.ProcessEnv;
  readonly lambda?: LambdaInvoker;
  readonly parameterStore?: SystemOperatorParameterStore;
}) {
  const installDefaults = parseInstallDefaultEntitlements(input.environment);
  const installations = makeInstallationRepository(input.database);
  const organizations = makePlatformOrganizationDirectory(input.database);
  const readers = makeSystemAwsReaders(defaultSystemAwsClients());
  const organizationStanding = makeSystemOrganizationStanding({
    egressAllowlist: makeOrganizationEgressAllowlistReader(input.database),
    installDefaults,
    standing: makeOrganizationStandingRepository({ database: input.database, installDefaults }),
  });
  const services = parseSystemServicePrincipals(input.environment);
  if (services.kind === "invalid") console.error(services.error);
  const principalStatus = makeSystemPrincipalStatus(
    identityPrincipalStatus(input.environment, input.lambda),
  );
  const principals = makeSystemPrincipals({
    directory: makePlatformPrincipalDirectory(input.database),
    identity: identityPrincipalCommands(input.environment, input.lambda),
  });
  let loading: Promise<SystemOperatorService> | undefined;

  async function load(): Promise<SystemOperatorService> {
    const loaded = await loadSystemOperatorConfiguration(input.environment, input.parameterStore);
    const dependencies = {
      installations,
      operatorAccess: makeSystemOperatorAccess(
        makeOperatorAccessRepository({ database: input.database }),
      ),
      organizationSpend: makeSystemOrganizationSpend({ database: input.database }),
      organizationStanding,
      organizations,
      principalStatus,
      principals,
      readers,
    };
    if (loaded.kind === "configured" || loaded.kind === "unconfigured") {
      return makeSystemOperatorService({
        ...dependencies,
        configuration: loaded.kind === "configured" ? loaded.configuration : undefined,
      });
    }
    if (loaded.kind === "unreadable") loading = undefined;
    console.error(loaded.error);
    return makeSystemOperatorService({
      ...dependencies,
      configuration: undefined,
      configurationError: loaded.error,
    });
  }

  return createSystemOperatorApi({
    authenticate: input.authenticate,
    observers: parseSystemObserverRoles(input.environment),
    service: async (route, request) => (await (loading ??= load()))(route, request),
    services,
  });
}
