import { Option, Schema } from "effect";
import {
  dnsOwnershipProof,
  dnsOwnershipProven,
  dnsOwnershipToken,
  type ObserveTxt,
} from "../dns-ownership-proof.ts";
import type { Ulid } from "../ids.ts";
import { PersistenceError } from "../persistence-types.ts";
import { LoginDomain, type OrganizationLoginDomainRecord } from "../records/identity-federation.ts";
import type {
  AdministrationContext,
  FederationAdministrator,
  FederationPage,
  FederationPageQuery,
} from "./administration-context.ts";
import { replaceWithClaims } from "./administration-context.ts";
import { createWithClaims, deleteWithClaims } from "./operations.ts";
import { federationRecord, nextFederationRecord } from "./record-builders.ts";

const AGGREGATE_TYPE = "organization-login-domain";
const MISSING = {
  code: "login_domain_not_found",
  message: "The login domain was not found.",
} as const;
const CONFLICT = {
  code: "login_domain_conflict",
  message: "The login domain changed concurrently.",
} as const;

export function loginDomainDnsRecord(
  domain: Pick<OrganizationLoginDomainRecord["data"], "domain" | "verificationToken">,
) {
  return dnsOwnershipProof("deployments-login", domain.domain, domain.verificationToken);
}

export interface LoginDomainAdministration {
  readonly listLoginDomains: (
    organizationId: Ulid,
    query: FederationPageQuery,
  ) => Promise<FederationPage<OrganizationLoginDomainRecord>>;
  readonly addLoginDomain: (
    administrator: FederationAdministrator,
    domain: string,
  ) => Promise<OrganizationLoginDomainRecord>;
  readonly verifyLoginDomain: (
    administrator: FederationAdministrator,
    id: Ulid,
    observeTxt: ObserveTxt,
  ) => Promise<OrganizationLoginDomainRecord>;
  readonly removeLoginDomain: (
    administrator: FederationAdministrator,
    id: Ulid,
  ) => Promise<OrganizationLoginDomainRecord>;
}

export function makeLoginDomainAdministration(
  context: AdministrationContext,
): LoginDomainAdministration {
  const stored = (organizationId: Ulid, id: Ulid) =>
    context.organizationRecord(organizationId, "organization-login-domain", id, MISSING);

  async function assertNotClaimedElsewhere(organizationId: Ulid, domain: string) {
    const owner = await context.reads.verifiedDomainOwner(domain);
    if (owner && owner.data.organizationId !== organizationId) {
      throw new PersistenceError(
        "conflict",
        "domain_claimed",
        "Another organization has already verified this domain.",
      );
    }
  }

  return {
    listLoginDomains: (organizationId, query) =>
      context.page(organizationId, "organization-login-domain", query),

    addLoginDomain: async (administrator, input) => {
      const domain = Schema.decodeUnknownOption(LoginDomain)(input.trim().toLowerCase());
      if (Option.isNone(domain)) {
        throw new PersistenceError(
          "unprocessable",
          "invalid_login_domain",
          "Login domains are ASCII host names with at least two labels.",
        );
      }
      const at = context.now().toISOString();
      const record = federationRecord("organization-login-domain", {
        createdAt: at,
        domain: domain.value,
        id: context.generateId(),
        organizationId: administrator.organizationId,
        state: { kind: "pending" },
        updatedAt: at,
        verificationToken: dnsOwnershipToken(),
        version: 1,
      });
      await context.commit(
        administrator,
        createWithClaims(record, at),
        {
          aggregateId: record.data.id,
          aggregateType: AGGREGATE_TYPE,
          aggregateVersion: 1,
          eventType: "organization-login-domain.added",
          occurredAt: at,
          payload: { domain: record.data.domain, state: "pending" },
        },
        {
          code: "login_domain_exists",
          message: "The organization has already added this login domain.",
        },
      );
      return record;
    },

    verifyLoginDomain: async (administrator, id, observeTxt) => {
      const current = await stored(administrator.organizationId, id);
      if (current.data.state.kind === "verified") return current;
      const expected = loginDomainDnsRecord(current.data);
      if (!(await dnsOwnershipProven(expected, observeTxt))) {
        throw new PersistenceError(
          "unprocessable",
          "txt_not_found",
          `No TXT record at ${expected.name} contains ${expected.value}.`,
        );
      }
      await assertNotClaimedElsewhere(administrator.organizationId, current.data.domain);
      const at = context.now().toISOString();
      const verified = nextFederationRecord(
        current,
        { state: { kind: "verified", verifiedAt: at } },
        at,
      );
      try {
        await context.commit(
          administrator,
          replaceWithClaims(current, verified, at),
          {
            aggregateId: id,
            aggregateType: AGGREGATE_TYPE,
            aggregateVersion: verified.data.version,
            eventType: "organization-login-domain.verified",
            occurredAt: at,
            payload: { domain: verified.data.domain, state: "verified" },
          },
          CONFLICT,
        );
      } catch (cause) {
        if (!(cause instanceof PersistenceError) || cause.code !== CONFLICT.code) throw cause;
        await assertNotClaimedElsewhere(administrator.organizationId, current.data.domain);
        const latest = await stored(administrator.organizationId, id);
        if (latest.data.state.kind === "verified") return latest;
        throw cause;
      }
      return verified;
    },

    removeLoginDomain: async (administrator, id) => {
      const current = await stored(administrator.organizationId, id);
      await context.commit(
        administrator,
        deleteWithClaims(current),
        {
          aggregateId: id,
          aggregateType: AGGREGATE_TYPE,
          aggregateVersion: current.data.version + 1,
          eventType: "organization-login-domain.removed",
          occurredAt: context.now().toISOString(),
          payload: { domain: current.data.domain, state: current.data.state.kind },
        },
        CONFLICT,
      );
      return current;
    },
  };
}
