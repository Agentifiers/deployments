import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import { canonicalRecordKeys } from "../record-keys.ts";
import {
  OAuthAuthorizationAttemptRecord,
  ProviderApplicationRecord,
  ProviderConnectionRecord,
} from "../records/control.ts";
import { tableForItemType, withCanonicalRecordKeys } from "../records/index.ts";
import { hasSameImmutableIdentity } from "../transaction-conditions.ts";
import { uniqueClaimRequirements } from "../unique-claims.ts";

const [environmentId, organizationId, projectId, applicationId, principalId, connectionId] =
  Array.from({ length: 6 }, (_, index) =>
    Schema.decodeUnknownSync(Ulid)(`01ARZ3NDEKTSV4RRFFQ69G5F${String(index).padStart(2, "0")}`),
  ) as [Ulid, Ulid, Ulid, Ulid, Ulid, Ulid];
const createdAt = "2026-09-30T00:00:00.000Z";
const issuer = "https://auth.vendor.example";

function application(data: Readonly<Record<string, unknown>>) {
  return Schema.decodeUnknownSync(ProviderApplicationRecord)(
    withCanonicalRecordKeys({
      data: {
        clientId: "client-1",
        createdAt,
        displayName: "Vendor",
        environmentId,
        id: applicationId,
        organizationId,
        projectId,
        providerKey: "vendor",
        redirectUris: ["https://api.example/callback"],
        requestedScopes: [],
        status: "active",
        updatedAt: createdAt,
        version: 0,
        ...data,
      },
      itemType: "provider-application" as const,
    }),
  );
}

function attempt(data: Readonly<Record<string, unknown>>) {
  const expiresAt = "2026-09-30T00:10:00.000Z";
  return Schema.decodeUnknownSync(OAuthAuthorizationAttemptRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt,
        environmentId,
        expiresAt,
        id: connectionId,
        oauthClientId: "https://api.example/client-metadata.json",
        oauthClientRegistration: "client_id_metadata_document",
        oauthIssParameterSupported: true,
        oauthIssuer: issuer,
        organizationId,
        principalId,
        projectId,
        providerApplicationId: applicationId,
        providerKey: "vendor",
        requestedScopes: [],
        stateHash: "state-hash",
        status: "pending",
        version: 0,
        ...data,
      },
      itemType: "oauth-authorization-attempt" as const,
      ttl: Math.floor(Date.parse(expiresAt) / 1_000),
    }),
  );
}

describe("vendor MCP OAuth record fields", () => {
  test("round-trips attempt, connection, and application OAuth client fields", () => {
    expect(attempt({}).data).toMatchObject({
      oauthClientRegistration: "client_id_metadata_document",
      oauthIssParameterSupported: true,
      oauthIssuer: issuer,
    });
    const connection = Schema.decodeUnknownSync(ProviderConnectionRecord)(
      withCanonicalRecordKeys({
        data: {
          authMethod: "oauth",
          createdAt,
          environmentId,
          id: connectionId,
          oauthClientId: "client-1",
          oauthClientRegistration: "dynamic_client_registration",
          oauthIssuer: issuer,
          organizationId,
          projectId,
          providerKey: "vendor",
          scopes: [],
          status: "active",
          updatedAt: createdAt,
          version: 0,
        },
        itemType: "provider-connection" as const,
      }),
    );
    expect(Schema.encodeSync(ProviderConnectionRecord)(connection).data).toMatchObject({
      oauthClientRegistration: "dynamic_client_registration",
      oauthIssuer: issuer,
    });
    const registration = {
      issuer,
      method: "dynamic_client_registration",
      registeredAt: createdAt,
      tokenEndpointAuthMethod: "client_secret_basic",
    } as const;
    expect(application({ registration }).data.registration).toEqual(registration);
  });

  test("rejects unknown registration literals and dynamic registrations without an issuer", () => {
    expect(() => attempt({ oauthClientRegistration: "implicit" })).toThrow();
    expect(() =>
      application({
        registration: { method: "dynamic_client_registration", tokenEndpointAuthMethod: "none" },
      }),
    ).toThrow();
    expect(() =>
      application({
        registration: { issuer, method: "pre_registered", tokenEndpointAuthMethod: "private_key" },
      }),
    ).toThrow();
    expect(
      application({ registration: { method: "pre_registered", tokenEndpointAuthMethod: "none" } })
        .data.registration?.method,
    ).toBe("pre_registered");
  });

  test("treats the attempt's OAuth client binding as immutable identity", () => {
    const original = attempt({});
    for (const change of [
      { oauthClientId: "other-client" },
      { oauthClientRegistration: "pre_registered" },
      { oauthIssParameterSupported: false },
      { oauthIssuer: "https://other.example" },
    ]) {
      const replacement = attempt({ ...change, version: 1 });
      expect(hasSameImmutableIdentity(original, replacement)).toBe(false);
    }
    expect(hasSameImmutableIdentity(original, attempt({ status: "completed", version: 1 }))).toBe(
      true,
    );
  });

  test("accepts CIMD attempts without a provider application and keeps that binding immutable", () => {
    const { providerApplicationId: _, ...withoutApplication } = attempt({}).data;
    const cimd = Schema.decodeUnknownSync(OAuthAuthorizationAttemptRecord)(
      withCanonicalRecordKeys({
        data: withoutApplication,
        itemType: "oauth-authorization-attempt" as const,
        ttl: Math.floor(Date.parse(withoutApplication.expiresAt) / 1_000),
      }),
    );
    expect(cimd.data.providerApplicationId).toBeUndefined();
    expect(hasSameImmutableIdentity(cimd, attempt({ version: 1 }))).toBe(false);
  });
});

describe("provider application registration claims", () => {
  const clientIdNamespace = `environment:${environmentId}:provider-application:vendor`;
  const registrationNamespace = `environment:${environmentId}:provider-application-registration:vendor`;
  const dynamic = {
    issuer,
    method: "dynamic_client_registration",
    tokenEndpointAuthMethod: "none",
  };

  test("claims the issuer slot for active dynamic registrations alongside the client id", () => {
    expect(
      uniqueClaimRequirements(application({ registration: dynamic })).map((claim) => [
        claim.namespace,
        claim.value,
      ]),
    ).toEqual([
      [clientIdNamespace, "client-1"],
      [registrationNamespace, issuer],
    ]);
  });

  test("only claims the client id for pre-registered or unregistered applications", () => {
    for (const registration of [
      undefined,
      { issuer, method: "pre_registered", tokenEndpointAuthMethod: "client_secret_post" },
    ]) {
      expect(
        uniqueClaimRequirements(application(registration ? { registration } : {})).map(
          (claim) => claim.namespace,
        ),
      ).toEqual([clientIdNamespace]);
    }
  });

  test("releases the issuer slot but keeps the client id once archived or disabled", () => {
    for (const status of ["archived", "disabled"]) {
      expect(
        uniqueClaimRequirements(application({ registration: dynamic, status })).map(
          (claim) => claim.namespace,
        ),
      ).toEqual([clientIdNamespace]);
    }
  });
});

describe("oauth refresh claim keys", () => {
  test("lives in the execution table under the environment partition", () => {
    const keys = canonicalRecordKeys(
      {
        data: { connectionId, credentialGeneration: 0, environmentId, organizationId, projectId },
        itemType: "oauth-refresh-claim",
      },
      "execution",
    );
    expect(tableForItemType("oauth-refresh-claim")).toBe("execution");
    expect(keys.pk).toBe(`ORG#${organizationId}#ENV#${environmentId}`);
    expect(keys.sk).toBe(`OAUTH-REFRESH-CLAIM#${connectionId}#0`);
  });
});
