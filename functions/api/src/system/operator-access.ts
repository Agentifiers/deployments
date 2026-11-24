import {
  OpenSystemOrganizationAccessRequest,
  type CloseSystemOrganizationAccessResponse,
  type GetSystemOrganizationAccessResponse,
  type ListSystemOperatorAccessResponse,
  type OpenSystemOrganizationAccessResponse,
  type SystemOrganizationAccessResponse,
} from "@deployments-ai/api-contract/system";
import { Ulid, type OperatorAccessRepository, type OperatorAccessView } from "@deployments-ai/db";
import { Schema } from "effect";
import { SystemOperatorProblem, parseBody } from "./service.ts";

const decodeOpen = Schema.decodeUnknownSync(OpenSystemOrganizationAccessRequest, {
  onExcessProperty: "error",
});
const isUlid = Schema.is(Ulid);

type AccessView = typeof SystemOrganizationAccessResponse.Encoded;

interface CallerAccess {
  readonly operatorId: string;
  readonly organizationId: string;
}

export interface SystemOperatorAccess {
  readonly get: (
    input: CallerAccess,
  ) => Promise<typeof GetSystemOrganizationAccessResponse.Encoded>;
  readonly open: (
    input: CallerAccess & { readonly body: unknown },
  ) => Promise<typeof OpenSystemOrganizationAccessResponse.Encoded>;
  readonly close: (
    input: CallerAccess,
  ) => Promise<typeof CloseSystemOrganizationAccessResponse.Encoded>;
  readonly list: (input: {
    readonly cursor?: string;
    readonly limit?: number;
    readonly organizationId?: string;
  }) => Promise<typeof ListSystemOperatorAccessResponse.Encoded>;
}

function view(access: OperatorAccessView): AccessView {
  return {
    closedAt: access.state.kind === "closed" ? access.state.closedAt : null,
    expiresAt: access.expiresAt,
    grantId: access.grantId,
    openedAt: access.openedAt,
    organizationId: access.organizationId,
    principalId: access.principalId,
    reason: access.reason,
    status: access.status,
    ticket: access.ticket ?? null,
  };
}

function ulid(value: string, name: string) {
  if (!isUlid(value)) {
    throw new SystemOperatorProblem(400, `invalid_${name}`, `${name} must be a canonical ULID.`);
  }
  return value;
}

/** The system routes over the caller's own operator access records. */
export function makeSystemOperatorAccess(access: OperatorAccessRepository): SystemOperatorAccess {
  return {
    close: async ({ operatorId, organizationId }) => {
      const outcome = await access.close({
        organizationId: ulid(organizationId, "organizationId"),
        principalId: ulid(operatorId, "principalId"),
      });
      return { access: outcome.access ? view(outcome.access) : null, changed: outcome.changed };
    },
    get: async ({ operatorId, organizationId }) => {
      const stored = await access.get({
        organizationId: ulid(organizationId, "organizationId"),
        principalId: ulid(operatorId, "principalId"),
      });
      return {
        access: stored.access ? view(stored.access) : null,
        organization: stored.organization,
      };
    },
    list: async ({ cursor, limit, organizationId }) => {
      const page = await access.listOpen({
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
        ...(organizationId === undefined
          ? {}
          : { organizationId: ulid(organizationId, "organizationId") }),
      });
      return { items: page.items.map(view), nextCursor: page.nextCursor ?? null };
    },
    open: async ({ body, operatorId, organizationId }) => {
      const { durationMinutes, reason, ticket } = parseBody(decodeOpen, body);
      const outcome = await access.open({
        ...(durationMinutes === undefined ? {} : { durationMinutes }),
        organizationId: ulid(organizationId, "organizationId"),
        principalId: ulid(operatorId, "principalId"),
        reason: reason.trim(),
        ...(ticket === undefined ? {} : { ticket: ticket.trim() }),
      });
      return { access: view(outcome.access), renewed: outcome.kind === "renewed" };
    },
  };
}
