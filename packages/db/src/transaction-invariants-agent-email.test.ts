import { describe, expect, it } from "bun:test";
import { Effect, Schema } from "effect";
import { Ulid } from "./ids.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "./records/index.ts";
import { validateTransactionInvariants } from "./transaction-invariants.ts";
import { makeUniqueClaimRecord, uniqueClaimRequirements } from "./unique-claims.ts";

const ORGANIZATION_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const PROJECT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAW");
const ENVIRONMENT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAX");
const DOMAIN_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAY");
const NOW = "2026-07-20T00:00:00.000Z";

function domainLifecycle() {
  const pending = withCanonicalRecordKeys({
    data: {
      createdAt: NOW,
      dnsRecords: [],
      domain: "mail.example.com",
      environmentId: ENVIRONMENT_ID,
      id: DOMAIN_ID,
      mailFromDomain: "bounce.mail.example.com",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      providerManaged: false,
      providerMetadata: {},
      status: "pending" as const,
      updatedAt: NOW,
      version: 0,
    },
    itemType: "inbox-domain" as const,
  });
  const verified = withCanonicalRecordKeys({
    ...pending,
    data: {
      ...pending.data,
      status: "verified" as const,
      updatedAt: "2026-07-20T00:01:00.000Z",
      verifiedAt: "2026-07-20T00:01:00.000Z",
      version: 1,
    },
  });
  const revoked = withCanonicalRecordKeys({
    ...verified,
    data: {
      ...verified.data,
      status: "revoked" as const,
      updatedAt: "2026-07-20T00:02:00.000Z",
      version: 2,
    },
  });
  return { pending, revoked, verified };
}

describe("agent email domain transaction invariants", () => {
  it("accepts registration, ownership acquisition, and ownership release", async () => {
    const { pending, revoked, verified } = domainLifecycle();
    const [registration] = uniqueClaimRequirements(pending);
    const ownership = uniqueClaimRequirements(verified).find(
      (requirement) => requirement.namespace === "inbox-domain",
    );
    if (!registration || !ownership) throw new Error("Domain claim requirements are missing.");
    const registrationClaim = makeUniqueClaimRecord(registration, NOW) as Extract<
      PlatformRecord,
      { readonly itemType: "unique-claim" }
    >;
    const ownershipClaim = makeUniqueClaimRecord(ownership, NOW) as Extract<
      PlatformRecord,
      { readonly itemType: "unique-claim" }
    >;

    expect(
      Effect.runPromise(
        validateTransactionInvariants([
          { kind: "put", record: pending },
          { kind: "put", record: registrationClaim },
        ]),
      ),
    ).resolves.toBeArray();
    expect(
      Effect.runPromise(
        validateTransactionInvariants([
          { kind: "put", previousRecord: pending, record: verified },
          { kind: "put", record: ownershipClaim },
        ]),
      ),
    ).resolves.toBeArray();
    expect(
      Effect.runPromise(
        validateTransactionInvariants([
          { kind: "put", previousRecord: verified, record: revoked },
          { kind: "delete", record: ownershipClaim },
        ]),
      ),
    ).resolves.toBeArray();
  });
});
