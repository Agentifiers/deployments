import { randomUUID } from "node:crypto";
import { decodePublicResponse, ORGANIZATION_SPEND_API_ROUTES } from "@deployments-ai/api-contract";
import {
  makeOrganizationStandingRepository,
  organizationRoleAllows,
  readMonthSpend,
  readProjectMonthSpend,
  requestedSpendMonth,
  Ulid,
  type DynamoDatabaseService,
  type OrganizationStandingRepository,
} from "@deployments-ai/db";
import { parseInstallDefaultEntitlements } from "@deployments-ai/tenant-limits/install-defaults";
import { Option, Schema } from "effect";
import type { ApiIdentity } from "./api-service-contracts.ts";
import { errorLogFields } from "./error-log-fields.ts";
import { routePattern } from "./route-request-parsing.ts";
import { actsUnderOperatorAccess, permits } from "./scope-permissions.ts";

const [route, projectRoute] = ORGANIZATION_SPEND_API_ROUTES;
const { pattern } = routePattern(route.path);
const projectPattern = routePattern(projectRoute.path).pattern;
const decodeUlid = Schema.decodeUnknownOption(Ulid);

const TITLES: Readonly<Record<number, string>> = {
  400: "Bad request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not found",
};

class SpendProblem extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function problem(status: number, code: string, detail: string, requestId: string) {
  return Response.json(
    { code, detail, requestId, status, title: TITLES[status] ?? "Request failed" },
    {
      headers: { "content-type": "application/problem+json", "x-request-id": requestId },
      status,
    },
  );
}

/** The organization in the path, which the scope header and the caller's membership must match. */
function memberOrganization(request: Request, identity: ApiIdentity, rawOrganizationId: string) {
  const organizationId = Option.getOrThrowWith(
    decodeUlid(rawOrganizationId),
    () => new SpendProblem(404, "organization_not_found", "The organization was not found."),
  );
  const header = request.headers.get("x-deployments-organization")?.trim();
  if (!header) {
    throw new SpendProblem(
      400,
      "missing_organization_context",
      "x-deployments-organization is required.",
    );
  }
  const granted = identity.organizationIds;
  if (header !== organizationId || (granted !== "*" && !granted?.includes(organizationId))) {
    throw new SpendProblem(
      403,
      "organization_scope_violation",
      "The credential cannot access the requested organization.",
    );
  }
  if (!permits(identity.scopes, route.requiredAuthorization)) {
    throw new SpendProblem(
      403,
      "insufficient_scope",
      `The credential does not have the required ${route.requiredAuthorization} capability.`,
    );
  }
  if (
    !actsUnderOperatorAccess(identity, organizationId) &&
    !organizationRoleAllows(identity.organizationRole, "organization.read")
  ) {
    throw new SpendProblem(
      403,
      "insufficient_role",
      "Only members of the organization read its spend.",
    );
  }
  return organizationId;
}

/**
 * `GET /v1/organizations/{id}/spend` and `/spend/projects`: a member's view of the organization's
 * month spend, as a total or split by project.
 */
export function createOrganizationSpendApi(options: {
  readonly authenticate: (request: Request) => Promise<ApiIdentity | null>;
  readonly database: DynamoDatabaseService;
  readonly now?: () => Date;
  readonly requestId?: () => string;
  readonly standing: Pick<OrganizationStandingRepository, "read">;
}) {
  const now = options.now ?? (() => new Date());
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (request.method.toUpperCase() !== route.method) return undefined;
    const projectMatch = projectPattern.exec(url.pathname);
    const match = projectMatch ?? pattern.exec(url.pathname);
    if (!match) return undefined;
    const requestId = options.requestId?.() ?? randomUUID();
    try {
      const identity = await options.authenticate(request);
      if (!identity) {
        return problem(401, "unauthorized", "A valid bearer credential is required.", requestId);
      }
      const organizationId = memberOrganization(request, identity, match[1] ?? "");
      const asOf = now();
      const month = Option.getOrThrowWith(
        requestedSpendMonth(url.searchParams.get("month") ?? undefined, asOf),
        () =>
          new SpendProblem(
            400,
            "invalid_month",
            "month must be a UTC month as YYYY-MM, no later than the current month.",
          ),
      );
      if (projectMatch) {
        const items = await readProjectMonthSpend(options.database, organizationId, asOf, month);
        return Response.json(
          decodePublicResponse(projectRoute.name, {
            asOf: asOf.toISOString(),
            items,
            month,
            organizationId,
            periodStart: `${month}-01T00:00:00.000Z`,
          }),
          { headers: { "x-request-id": requestId }, status: projectRoute.successStatus },
        );
      }
      const [spend, standing] = await Promise.all([
        readMonthSpend(options.database, organizationId, { scope: "organization" }, asOf, month),
        options.standing.read(organizationId, { consistent: true }),
      ]);
      return Response.json(
        decodePublicResponse(route.name, {
          ...spend,
          month,
          operatorFundedModelSpendCeiling: standing.entitlements.operatorFundedModelSpendCeiling,
          organizationId,
        }),
        { headers: { "x-request-id": requestId }, status: route.successStatus },
      );
    } catch (cause) {
      if (cause instanceof SpendProblem) {
        return problem(cause.status, cause.code, cause.message, requestId);
      }
      console.error("Organization spend request failed.", { ...errorLogFields(cause), requestId });
      return problem(500, "internal_error", "The organization spend request failed.", requestId);
    }
  };
}

export function organizationSpendApiFromEnvironment(input: {
  readonly authenticate: (request: Request) => Promise<ApiIdentity | null>;
  readonly database: DynamoDatabaseService;
  readonly environment: Readonly<Record<string, string | undefined>>;
}) {
  return createOrganizationSpendApi({
    authenticate: input.authenticate,
    database: input.database,
    standing: makeOrganizationStandingRepository({
      database: input.database,
      installDefaults: parseInstallDefaultEntitlements(input.environment),
    }),
  });
}
