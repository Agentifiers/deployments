import { createHash, randomUUID } from "node:crypto";
import {
  EGRESS_ALLOWLIST_API_ROUTES,
  IdempotencyKey,
  PUBLIC_ID_PATTERN,
  ReplaceOrganizationEgressAllowlistRequest,
  decodePublicResponse,
} from "@deployments-ai/api-contract";
import {
  PersistenceError,
  Ulid,
  egressAllowlistIssues,
  makeOrganizationEgressAllowlistRepository,
  organizationRoleAllows,
  organizationRolesAllowing,
  type DynamoDatabaseService,
  type EgressAllowlistIssue,
  type IdempotencyPersistence,
  type OrganizationEgressAllowlist,
  type OrganizationEgressAllowlistRepository,
} from "@deployments-ai/db";
import { Option, Schema, SchemaIssue } from "effect";
import type { ApiIdentity } from "./api-service-contracts.ts";
import { errorLogFields } from "./error-log-fields.ts";
import { persistenceStatus } from "./persistence-error-status.ts";
import { routePattern } from "./route-request-parsing.ts";
import { actsUnderOperatorAccess, identityPermits } from "./scope-permissions.ts";

const [getRoute, replaceRoute] = EGRESS_ALLOWLIST_API_ROUTES;
const { pattern } = routePattern(getRoute.path);
const decodeUlid = Schema.decodeUnknownOption(Ulid);
const decodeIdempotencyKey = Schema.decodeUnknownOption(IdempotencyKey);
const decodeBody = Schema.decodeUnknownSync(ReplaceOrganizationEgressAllowlistRequest, {
  onExcessProperty: "error",
});
const standardIssues = SchemaIssue.makeFormatterStandardSchemaV1();

class AllowlistProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extensions: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "AllowlistProblem";
  }
}

function problemResponse(cause: unknown, requestId: string) {
  const known =
    cause instanceof AllowlistProblem
      ? cause
      : cause instanceof PersistenceError
        ? new AllowlistProblem(persistenceStatus(cause), cause.code, cause.message)
        : undefined;
  if (!known) {
    console.error("Egress allowlist request failed.", { ...errorLogFields(cause), requestId });
  }
  const { code, extensions, message, status } =
    known ?? new AllowlistProblem(500, "internal_error", "The egress allowlist request failed.");
  return Response.json(
    {
      code,
      ...extensions,
      requestId,
      status,
      title: status === 500 ? "Internal server error" : message,
      type: `https://docs.deployments.ai/errors/${code.replaceAll("_", "-")}`,
    },
    {
      headers: { "content-type": "application/problem+json", "x-request-id": requestId },
      status,
    },
  );
}

function invalid(issues: readonly EgressAllowlistIssue[]) {
  const [first] = issues;
  return new AllowlistProblem(
    400,
    "invalid_egress_allowlist",
    first ? `${first.pointer}: ${first.message}` : "The request body is invalid.",
    { errors: issues, pointer: first?.pointer ?? "" },
  );
}

/** Parses the PUT body into entries, or throws a 400 that names each broken rule's pointer. */
function parseEntries(text: string) {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AllowlistProblem(400, "invalid_json", "The request body must be valid JSON.", {
      pointer: "",
    });
  }
  let body: typeof ReplaceOrganizationEgressAllowlistRequest.Type;
  try {
    body = decodeBody(json);
  } catch (cause) {
    if (!Schema.isSchemaError(cause)) throw cause;
    throw invalid(
      standardIssues(cause.issue).issues.map(({ message, path }) => ({
        message,
        pointer: (path ?? [])
          .map((segment) => `/${String(typeof segment === "object" ? segment.key : segment)}`)
          .join(""),
      })),
    );
  }
  const issues = egressAllowlistIssues(body.entries);
  if (issues.length > 0) throw invalid(issues);
  return body.entries.map(({ note, origin }) =>
    note === undefined ? { origin } : { note, origin },
  );
}

function responseView(allowlist: OrganizationEgressAllowlist) {
  return {
    entries: allowlist.entries,
    organizationId: allowlist.organizationId,
    updatedAt: allowlist.updatedAt ?? null,
    updatedByPrincipalId: allowlist.updatedByPrincipalId ?? null,
    version: allowlist.version,
  };
}

/**
 * `GET` and `PUT /v1/organizations/{id}/egress-allowlist`. Authorization mirrors the governance
 * routes: governance scopes for every caller, and for a person a role that may mutate resources.
 */
export function createEgressAllowlistApi(options: {
  readonly authenticate: (request: Request) => Promise<ApiIdentity | null>;
  readonly idempotency: Pick<IdempotencyPersistence, "execute">;
  readonly repository: OrganizationEgressAllowlistRepository;
  readonly requestId?: () => string;
}) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const route = [getRoute, replaceRoute].find((candidate) => candidate.method === method);
    const match = pattern.exec(url.pathname);
    if (!route || !match) return undefined;
    const requestId = options.requestId?.() ?? `req_${randomUUID()}`;
    try {
      const identity = await options.authenticate(request);
      if (!identity) {
        throw new AllowlistProblem(401, "unauthorized", "A valid bearer credential is required.");
      }
      const organizationId = Option.getOrThrowWith(
        decodeUlid(decodeURIComponent(match[1] ?? "")),
        () =>
          new AllowlistProblem(404, "organization_not_found", "The organization was not found."),
      );
      const header = request.headers.get("x-deployments-organization")?.trim();
      if (!header) {
        throw new AllowlistProblem(
          400,
          "missing_scope",
          "The organization scope header is required.",
        );
      }
      if (!PUBLIC_ID_PATTERN.test(header) || header !== organizationId) {
        throw new AllowlistProblem(
          403,
          "organization_scope_violation",
          "The organization scope header must match the organization path.",
        );
      }
      if (identity.organizationIds !== "*" && !identity.organizationIds?.includes(organizationId)) {
        throw new AllowlistProblem(
          403,
          "organization_scope_violation",
          "The credential cannot access the requested organization.",
        );
      }
      if (!identityPermits(identity, route.requiredAuthorization)) {
        throw new AllowlistProblem(
          403,
          "insufficient_scope",
          `The credential does not have the required ${route.requiredAuthorization} capability.`,
        );
      }
      if (route.method === "GET") {
        return Response.json(
          decodePublicResponse(
            route.name,
            responseView(await options.repository.read(organizationId, { consistent: true })),
          ),
          { headers: { "x-request-id": requestId }, status: route.successStatus },
        );
      }

      // API keys carry no organization role, so only a person (or an operator) writes the list.
      const operatorAccess = actsUnderOperatorAccess(identity, organizationId);
      if (
        !operatorAccess &&
        !organizationRoleAllows(identity.organizationRole, "resources.mutate")
      ) {
        throw new AllowlistProblem(
          403,
          "insufficient_role",
          `Only people with one of these organization roles change the egress allowlist: ${organizationRolesAllowing("resources.mutate").join(", ")}.`,
        );
      }
      const idempotencyKey = Option.getOrThrowWith(
        decodeIdempotencyKey(request.headers.get("idempotency-key")?.trim() || undefined),
        () => new AllowlistProblem(400, "missing_idempotency_key", "Idempotency-Key is required."),
      );
      const principalId = Option.getOrThrowWith(
        decodeUlid(identity.principalId),
        () =>
          new AllowlistProblem(403, "insufficient_role", "The caller cannot change the allowlist."),
      );
      const entries = parseEntries(await request.text());
      const grantId = operatorAccess ? identity.operatorAccess?.grantId : undefined;
      const result = await options.idempotency.execute({
        fingerprint: createHash("sha256")
          .update(JSON.stringify([route.name, organizationId, principalId, entries]))
          .digest("hex"),
        key: idempotencyKey,
        operation: async () => {
          const { allowlist, changed } = await options.repository.replace({
            entries,
            ...(grantId ? { operatorAccessGrantId: grantId } : {}),
            organizationId,
            principalId,
          });
          return decodePublicResponse(route.name, { allowlist: responseView(allowlist), changed });
        },
        organizationId,
        principalId,
      });
      return Response.json(result, {
        headers: { "x-request-id": requestId },
        status: route.successStatus,
      });
    } catch (cause) {
      return problemResponse(cause, requestId);
    }
  };
}

export function egressAllowlistApiFromEnvironment(input: {
  readonly authenticate: (request: Request) => Promise<ApiIdentity | null>;
  readonly database: DynamoDatabaseService;
  readonly idempotency: Pick<IdempotencyPersistence, "execute">;
}) {
  return createEgressAllowlistApi({
    authenticate: input.authenticate,
    idempotency: input.idempotency,
    repository: makeOrganizationEgressAllowlistRepository(input.database),
  });
}
