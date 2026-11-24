import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import {
  IdentityEmailDeliveryRecord,
  OAuthRefreshFamilyRecord,
  WebBffSessionRecord,
} from "./identity-auth.ts";
import {
  bffFenceRecord,
  identityRateLimitRecord,
  identityRegistrationRecord,
  pendingEmailDeliveryRecord,
  principalRecord,
  publicEmailRequestRecord,
  refreshRecords,
  securityStateRecord,
  sessionRecords,
} from "../identity/record-builders.ts";
import type { Ulid } from "../ids.ts";
import { decodePlatformRecord, withCanonicalRecordKeys } from "./index.ts";
import { uniqueClaimRequirements } from "../unique-claims.ts";

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const TIME = "2026-07-28T00:00:00.000Z";
const EXPIRES = "2026-07-28T01:00:00.000Z";
const envelope = {
  algorithm: "AES-256-GCM" as const,
  authenticationTag: "tag",
  ciphertext: "ciphertext",
  encryptedDataKey: "encrypted-key",
  encryptionContextHash: "context-hash",
  iv: "iv",
  schemaVersion: 1 as const,
};

describe("identity auth records", () => {
  test("uses exact isolated identity keys and derives hashed email uniqueness", () => {
    const principal = principalRecord({
      createdAt: TIME,
      id: ID,
      platformRole: "administrator",
      primaryEmail: "user@example.com",
    });
    const security = securityStateRecord({
      createdAt: TIME,
      credentialVersion: 0,
      principalId: ID,
      sessionEpoch: 0,
      version: 1,
    });
    const fence = bffFenceRecord({
      createdAt: TIME,
      principalId: ID,
      principalStatus: "active",
      sessionEpoch: 0,
      version: 1,
    });
    expect(principal.pk).toBe(`PRINCIPAL#${ID}`);
    expect(principal.data.platformRole).toBe("administrator");
    expect(security.sk).toBe("PRINCIPAL-SECURITY-STATE#current");
    expect(fence.pk).toBe(`BFF-IDENTITY-FENCE#${ID}`);
    expect(uniqueClaimRequirements(principal)[0]?.value).toHaveLength(64);

    const registration = identityRegistrationRecord({
      createdAt: TIME,
      email: "user@example.com",
      emailHash: "email-hash",
      expiresAt: EXPIRES,
      id: ID,
      verificationEmailSentAt: TIME,
    });
    expect(registration.pk).toBe("IDENTITY-REGISTRATION#email-hash");
    expect(registration.ttl).toBe(Math.floor(Date.parse(EXPIRES) / 1_000));

    const rateLimit = identityRateLimitRecord({
      count: 1,
      expiresAt: EXPIRES,
      id: "counter-id",
      limitKey: "sign-up:source",
      scopeHash: "source-hash",
      version: 1,
      window: "123",
    });
    expect(rateLimit.pk).toBe("IDENTITY-RATE-LIMIT#sign-up%3Asource#source-hash#123");

    const publicRequest = publicEmailRequestRecord({
      createdAt: TIME,
      expiresAt: EXPIRES,
      id: ID,
      operation: "sign-up",
    });
    expect(publicRequest.pk).toBe(`IDENTITY-PUBLIC-EMAIL-REQUEST#${ID}`);
    expect(publicRequest.ttl).toBe(Math.floor(Date.parse(EXPIRES) / 1_000));
  });

  test("projects only pending email deliveries into a fixed shard", () => {
    const pending = pendingEmailDeliveryRecord({
      createdAt: TIME,
      dispatchShard: "03",
      expiresAt: EXPIRES,
      id: ID,
      principalId: ID,
      protectedPayload: envelope,
      purpose: "password-changed",
    });
    expect(pending.gsi1pk).toBe("IDENTITY-EMAIL-PENDING#03");
    expect(pending.ttl).toBe(Math.floor(Date.parse(EXPIRES) / 1000));
    expect(() =>
      Schema.decodeUnknownSync(IdentityEmailDeliveryRecord)({
        ...pending,
        data: { ...pending.data, dispatchShard: "16" },
      }),
    ).toThrow();
  });

  test("binds organization invitation deliveries to exactly their invitation", () => {
    const invitationDelivery = {
      createdAt: TIME,
      dispatchShard: "05",
      expiresAt: EXPIRES,
      id: ID,
      principalId: ID,
      protectedPayload: envelope,
    };
    const INVITATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as never;
    const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as never;
    const pending = pendingEmailDeliveryRecord({
      ...invitationDelivery,
      invitationId: INVITATION_ID,
      organizationId: ORGANIZATION_ID,
      purpose: "organization-invitation",
    });
    expect(pending.data).toMatchObject({
      invitationId: INVITATION_ID,
      organizationId: ORGANIZATION_ID,
      purpose: "organization-invitation",
    });
    expect(pending.pk).toBe(`IDENTITY-EMAIL-DELIVERY#${ID}`);
    expect(pending.gsi1pk).toBe("IDENTITY-EMAIL-PENDING#05");

    expect(() =>
      pendingEmailDeliveryRecord({
        ...invitationDelivery,
        organizationId: ORGANIZATION_ID,
        purpose: "organization-invitation",
      }),
    ).toThrow();
    expect(() =>
      pendingEmailDeliveryRecord({
        ...invitationDelivery,
        invitationId: INVITATION_ID,
        purpose: "organization-invitation",
      }),
    ).toThrow();
    expect(() =>
      pendingEmailDeliveryRecord({
        ...invitationDelivery,
        actionId: ID,
        invitationId: INVITATION_ID,
        organizationId: ORGANIZATION_ID,
        purpose: "organization-invitation",
      }),
    ).toThrow();
    expect(() =>
      pendingEmailDeliveryRecord({
        ...invitationDelivery,
        invitationId: INVITATION_ID,
        organizationId: ORGANIZATION_ID,
        purpose: "password-changed",
      }),
    ).toThrow();
  });

  test("recomputes status-dependent indexes for identity state transitions", () => {
    const pending = pendingEmailDeliveryRecord({
      createdAt: TIME,
      dispatchShard: "03",
      expiresAt: EXPIRES,
      id: ID,
      principalId: ID,
      protectedPayload: envelope,
      purpose: "password-changed",
    });
    const { nextDispatchAt: _next, ...pendingData } = pending.data as unknown as Record<
      string,
      unknown
    >;
    const queued = Schema.decodeUnknownSync(IdentityEmailDeliveryRecord)(
      withCanonicalRecordKeys({
        ...pending,
        data: { ...pendingData, queuedAt: TIME, status: "queued", version: 2 },
      }),
    );
    expect(queued.gsi1pk).toBeUndefined();
    expect(queued.gsi1sk).toBeUndefined();
    const {
      protectedPayload: _payload,
      queuedAt: _queued,
      ...queuedData
    } = queued.data as unknown as Record<string, unknown>;
    const discarded = Schema.decodeUnknownSync(IdentityEmailDeliveryRecord)(
      withCanonicalRecordKeys({
        ...queued,
        data: {
          ...queuedData,
          failedAt: TIME,
          failureCategory: "delivery-expired",
          status: "discarded",
          version: 3,
        },
      }),
    );
    expect(discarded.gsi1pk).toBeUndefined();
    expect(discarded.data).not.toHaveProperty("protectedPayload");

    const { family } = refreshRecords({
      audience: "https://api.deployments.ai",
      authenticationTime: TIME,
      clientId: "deployments-cli",
      createdAt: TIME,
      expiresAt: EXPIRES,
      familyId: ID,
      principalId: ID,
      scopes: ["offline_access"],
      sessionEpoch: 0,
      tokenHash: "token-hash",
      tokenId: ID,
    });
    const compromised = Schema.decodeUnknownSync(OAuthRefreshFamilyRecord)(
      withCanonicalRecordKeys({
        ...family,
        data: {
          ...family.data,
          revokedAt: TIME,
          status: "compromised",
          version: 2,
        },
      }),
    );
    expect(compromised.gsi1sk).toContain("OAUTH-REFRESH-FAMILY#compromised#");
  });

  test("binds session locators to principal and forbids credentials on terminal BFF sessions", () => {
    const { locator, session } = sessionRecords({
      authentication: { method: "password" },
      authenticationTime: TIME,
      createdAt: TIME,
      expiresAt: EXPIRES,
      id: ID,
      idleExpiresAt: EXPIRES,
      principalId: ID,
      sessionEpoch: 0,
      tokenHash: "token-hash",
    });
    expect(session.pk).toBe("IDENTITY-SESSION#token-hash");
    expect(locator.pk).toBe(`PRINCIPAL#${ID}`);
    expect(() =>
      Schema.decodeUnknownSync(WebBffSessionRecord, { onExcessProperty: "error" })({
        data: {
          clientId: "deployments-web",
          cookieTokenHash: "cookie-hash",
          createdAt: TIME,
          expiresAt: EXPIRES,
          id: ID,
          idleExpiresAt: EXPIRES,
          invalidatedAt: TIME,
          principalId: ID,
          protectedCredentials: envelope,
          refreshCredentialVersion: 1,
          sessionEpoch: 0,
          status: "reauthentication-required",
          updatedAt: TIME,
          version: 2,
        },
        itemType: "web-bff-session",
        pk: "WEB-BFF-SESSION#cookie-hash",
        sk: "WEB-BFF-SESSION#cookie-hash",
        ttl: Math.floor(Date.parse(EXPIRES) / 1000),
      }),
    ).toThrow();
  });

  test("reads a stored password session as password only and keeps a second factor", async () => {
    const stored = (authentication?: unknown) => {
      const { session } = sessionRecords({
        authentication: { method: "password" },
        authenticationTime: TIME,
        createdAt: TIME,
        expiresAt: EXPIRES,
        id: ID,
        idleExpiresAt: EXPIRES,
        principalId: ID,
        sessionEpoch: 0,
        tokenHash: "token-hash",
      });
      const { authentication: _authentication, ...data } = session.data;
      return { ...session, data: authentication ? { ...data, authentication } : data };
    };
    const authenticationOf = async (item: unknown) => {
      const record = await Effect.runPromise(decodePlatformRecord(item));
      return record.itemType === "identity-session" ? record.data.authentication : undefined;
    };

    expect(await authenticationOf(stored())).toEqual({ method: "password" });
    expect(await authenticationOf(stored({ method: "password" }))).toEqual({ method: "password" });
    expect(await authenticationOf(stored({ method: "password", secondFactor: "totp" }))).toEqual({
      method: "password",
      secondFactor: "totp",
    });
    expect(
      Effect.runPromise(decodePlatformRecord(stored({ method: "password", secondFactor: "sms" }))),
    ).rejects.toThrow();
  });
});
