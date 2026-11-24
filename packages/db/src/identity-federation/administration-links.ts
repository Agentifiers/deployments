import type { Ulid } from "../ids.ts";
import type { PrincipalIdentityRecord } from "../records/identity.ts";
import type {
  AdministrationContext,
  FederationAdministrator,
  FederationPage,
  FederationPageQuery,
} from "./administration-context.ts";
import { deleteWithClaims, endPrincipalSessions } from "./operations.ts";

type FederatedLink = typeof PrincipalIdentityRecord.Type;

export interface FederatedLinkAdministration {
  readonly listLinks: (
    organizationId: Ulid,
    query: FederationPageQuery,
  ) => Promise<FederationPage<FederatedLink>>;
  readonly deleteLink: (administrator: FederationAdministrator, id: Ulid) => Promise<FederatedLink>;
}

export function makeFederatedLinkAdministration(
  context: AdministrationContext,
): FederatedLinkAdministration {
  return {
    listLinks: (organizationId, query) => context.page(organizationId, "principal-identity", query),

    deleteLink: async (administrator, id) => {
      const link = await context.organizationRecord(
        administrator.organizationId,
        "principal-identity",
        id,
        { code: "link_not_found", message: "The federated link was not found." },
      );
      const [security, fence] = await Promise.all([
        context.reads.securityState(link.data.principalId),
        context.reads.bffFence(link.data.principalId),
      ]);
      if (!security || !fence) {
        throw new Error("A linked principal has no security state or revocation fence.");
      }
      const at = context.now().toISOString();
      await context.commit(
        administrator,
        [
          ...deleteWithClaims(link),
          ...endPrincipalSessions({ at, eventId: context.generateId(), fence, security }),
        ],
        {
          aggregateId: id,
          aggregateType: "principal-identity",
          aggregateVersion: await context.nextAggregateVersion(
            administrator.organizationId,
            "principal-identity",
            id,
          ),
          eventType: "principal-identity.removed",
          occurredAt: at,
          payload: {
            issuer: link.data.issuer,
            principalId: link.data.principalId,
            subject: link.data.subject,
          },
        },
        { code: "link_conflict", message: "The federated link changed concurrently." },
      );
      return link;
    },
  };
}
