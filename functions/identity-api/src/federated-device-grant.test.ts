import { expect, test } from "bun:test";
import {
  deviceGrantRecord,
  oauthClientRecord,
  principalRecord,
  securityStateRecord,
  sessionRecords,
  type IdentityRecord,
  type IdentityRepository,
  type TransactionOperation,
} from "@deployments-ai/db";
import { makeDeviceApplication } from "./device-application.ts";

const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as never;
const SESSION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as never;
const GRANT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as never;
const FAMILY_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as never;
const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0" as never;
const CONNECTION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB1" as never;
const APPROVAL_EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB2" as never;
const NOW = "2026-07-28T00:00:00.000Z";

test("a device approved from a federated session gets a grant keyed by its token sid", async () => {
  const principal = principalRecord({
    createdAt: NOW,
    id: PRINCIPAL_ID,
    primaryEmail: "a@acme.com",
  });
  const securityState = securityStateRecord({
    createdAt: NOW,
    credentialVersion: 0,
    emailVerifiedAt: NOW,
    principalId: PRINCIPAL_ID,
    sessionEpoch: 0,
    version: 1,
  });
  const { locator, session } = sessionRecords({
    authentication: {
      authenticatedAt: NOW,
      connectionId: CONNECTION_ID,
      issuer: "https://acme.okta.com",
      method: "federated",
      organizationId: ORGANIZATION_ID,
      subject: "00u-alice",
    },
    authenticationTime: NOW,
    createdAt: NOW,
    expiresAt: "2026-07-29T00:00:00.000Z",
    id: SESSION_ID,
    idleExpiresAt: "2026-07-28T01:00:00.000Z",
    principalId: PRINCIPAL_ID,
    sessionEpoch: 0,
    tokenHash: "session-token-hash",
  });
  const pending = deviceGrantRecord({
    clientId: "deployments-cli",
    createdAt: NOW,
    deviceCodeHash: "device-code-hash",
    expiresAt: "2026-07-28T00:10:00.000Z",
    id: GRANT_ID,
    pollingIntervalSeconds: 5,
    requestedScopes: ["offline_access", "organizations:read"],
    userCodeHash: "user-code-hash",
  });
  let grant: IdentityRecord<"oauth-device-grant"> = {
    ...pending,
    data: {
      ...pending.data,
      claimedBySessionId: SESSION_ID,
      principalId: PRINCIPAL_ID,
      status: "claimed",
      version: 2,
    },
  };
  const transactions: (readonly TransactionOperation[])[] = [];
  const ids = [APPROVAL_EVENT_ID, FAMILY_ID];
  const application = makeDeviceApplication(
    {
      generateId: () => ids.shift() ?? GRANT_ID,
      now: () => new Date(NOW),
      repository: {
        browserSessionVersionChecks: () => [],
        clientForId: () =>
          Promise.resolve(
            oauthClientRecord({
              allowedScopes: ["offline_access", "organizations:read"],
              clientId: "deployments-cli",
              createdAt: NOW,
              grantTypes: ["urn:ietf:params:oauth:grant-type:device_code"],
              name: "Deployments CLI",
              redirectUris: ["http://127.0.0.1/callback"],
              requiredScopes: [],
              tokenEndpointAuthMethod: "none",
              type: "public",
              version: 1,
            }),
          ),
        deviceGrantForHash: () => Promise.resolve(grant),
        deviceGrantForKey: () => Promise.resolve(grant),
        loadLoginMaterial: () =>
          Promise.resolve({ credential: undefined, principal, securityState }),
        loginMaterialVersionChecks: () => [],
        principalForId: () => Promise.resolve(principal),
        securityStateForPrincipal: () => Promise.resolve(securityState),
        sessionForHash: () => Promise.resolve(session),
        sessionLocator: () => Promise.resolve(locator),
        transact: (operations: readonly TransactionOperation[]) => {
          transactions.push(operations);
          for (const operation of operations) {
            if (operation.kind === "put" && operation.record.itemType === "oauth-device-grant") {
              grant = operation.record;
            }
          }
          return Promise.resolve();
        },
        userCodeClaim: () =>
          Promise.resolve({ data: { ownerPk: grant.pk, ownerSk: grant.sk } } as never),
      } as unknown as IdentityRepository,
      signer: { jwks: async () => ({ keys: [] }), sign: async () => "signed" },
    },
    {
      accessTokenSeconds: 600,
      applicationOrigin: "https://app.deployments.ai",
      deviceLifetimeSeconds: 600,
      issuer: "https://auth.deployments.ai",
      pollingIntervalSeconds: 5,
      refreshTokenSeconds: 2_592_000,
      resourceAudience: "https://api.deployments.ai",
    },
  );

  await application.decide(
    "ABCD-EFGH",
    { principalId: PRINCIPAL_ID, sessionId: SESSION_ID },
    "approved",
  );
  await application.poll({ clientId: "deployments-cli", deviceCode: "raw-device-code" });

  const grants = transactions
    .flat()
    .flatMap((operation) =>
      operation.kind === "put" && operation.record.itemType === "organization-federated-grant"
        ? [operation.record.data]
        : [],
    );
  expect(grants).toEqual([
    {
      authenticatedAt: NOW,
      connectionId: CONNECTION_ID,
      createdAt: NOW,
      expiresAt: "2026-07-28T12:00:00.000Z",
      id: FAMILY_ID,
      issuer: "https://acme.okta.com",
      organizationId: ORGANIZATION_ID,
      principalId: PRINCIPAL_ID,
      subject: "00u-alice",
    },
  ]);
});
