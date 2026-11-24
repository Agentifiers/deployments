import { describe, expect, test } from "bun:test";
import {
  acquireUniqueClaim,
  bffFenceRecord,
  DEFAULT_TABLE_NAMES,
  type IdentityRepository,
  IdentitySecurityEventRecord,
  makeDynamoDatabase,
  makeIdentityRepository,
  makeUniqueClaimRecord,
  passwordCredentialRecord,
  principalRecord,
  securityStateRecord,
  Ulid,
  UniqueClaimRecord,
  uniqueClaimRequirements,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import {
  DEFAULT_PASSWORD_PROFILE,
  emailClaimValue,
  randomToken,
  verifyPasswordEqualized,
} from "@deployments-ai/identity";
import { Schema } from "effect";
import { makePasswordApplication } from "../../functions/identity-api/src/password-application.ts";
import { bootstrapAdministrator } from "./admin-bootstrap.ts";

const ulid = Schema.decodeUnknownSync(Ulid);
const now = new Date("2026-10-09T04:02:10.000Z");
const registeredAt = "2026-10-01T00:00:00.000Z";

function install() {
  const table = fakeDynamoDocumentClient();
  const repository = makeIdentityRepository(makeDynamoDatabase(table.client, DEFAULT_TABLE_NAMES));
  const ids = [
    "01K7ADM1N000000000000000P1",
    "01K7ADM1N000000000000000E1",
    "01K7ADM1N000000000000000E2",
  ].map((id) => ulid(id));
  const bootstrap = (email: string) =>
    bootstrapAdministrator({
      email,
      generateId: () => {
        const id = ids.shift();
        if (!id) throw new Error("The test ran out of ids.");
        return id;
      },
      now,
      repository,
    });
  const securityEvents = () =>
    table
      .items("events")
      .filter((item) => item.itemType === "identity-security-event")
      .map((item) => {
        const { data } = Schema.decodeUnknownSync(IdentitySecurityEventRecord)(item);
        return [data.eventType, data.aggregateType, data.aggregateVersion, data.payload];
      });
  const itemCount = () =>
    ["control", "events", "identity"].reduce((count, name) => count + table.items(name).length, 0);
  return { bootstrap, itemCount, repository, securityEvents };
}

async function registeredHuman(
  repository: IdentityRepository,
  input: { readonly login: boolean; readonly status?: "active" | "disabled" },
) {
  const principalId = ulid("01K7REG1STERED000000000000");
  const principal = principalRecord({
    createdAt: registeredAt,
    id: principalId,
    primaryEmail: "ops@acme.example",
    ...(input.status ? { status: input.status } : {}),
  });
  const [emailClaim] = uniqueClaimRequirements(principal);
  if (!emailClaim) throw new Error("A human principal derives an email uniqueness claim.");
  await repository.transact([
    { kind: "put", record: principal },
    acquireUniqueClaim(
      Schema.decodeUnknownSync(UniqueClaimRecord)(makeUniqueClaimRecord(emailClaim, registeredAt)),
    ),
    ...(input.login
      ? [
          {
            kind: "put" as const,
            record: passwordCredentialRecord({
              createdAt: registeredAt,
              passwordHash: "scrypt-hash",
              principalId,
              version: 1,
            }),
          },
          {
            kind: "put" as const,
            record: securityStateRecord({
              createdAt: registeredAt,
              credentialVersion: 1,
              emailVerifiedAt: registeredAt,
              principalId,
              sessionEpoch: 0,
              version: 1,
            }),
          },
          {
            kind: "put" as const,
            record: bffFenceRecord({
              createdAt: registeredAt,
              principalId,
              principalStatus: input.status ?? "active",
              sessionEpoch: 0,
              version: 1,
            }),
          },
        ]
      : []),
  ]);
}

describe("admin bootstrap", () => {
  test("creates an administrator who sets a password through the reset email", async () => {
    const { bootstrap, repository, securityEvents } = install();

    expect(await bootstrap(" Admin@Acme.Example ")).toEqual({
      outcome: "created",
      principalId: ulid("01K7ADM1N000000000000000P1"),
    });
    expect(
      (await repository.principalForEmailHash(emailClaimValue("admin@acme.example")))?.data,
    ).toMatchObject({
      id: "01K7ADM1N000000000000000P1",
      kind: "human",
      platformRole: "administrator",
      primaryEmail: "admin@acme.example",
      status: "active",
    });
    expect(securityEvents()).toEqual([
      ["identity.principal-created", "principal", 1, { platformRole: "administrator" }],
    ]);

    const random = { bytes: (length: number) => new Uint8Array(length).fill(7) };
    let resetIds = 0;
    const passwords = makePasswordApplication(
      {
        encryptEmailPayload: async () => ({
          algorithm: "AES-256-GCM",
          authenticationTag: "tag",
          ciphertext: "ciphertext",
          encryptedDataKey: "encrypted-key",
          encryptionContextHash: "context-hash",
          iv: "iv",
          schemaVersion: 1,
        }),
        generateId: () => ulid(`01K7RESET${String(resetIds++).padStart(17, "0")}`),
        now: () => new Date("2026-10-09T04:05:00.000Z"),
        random,
        repository,
      },
      {
        actionLifetimeSeconds: 1_800,
        notificationLifetimeSeconds: 86_400,
        passwordProfiles: [DEFAULT_PASSWORD_PROFILE],
      },
    );
    await passwords.forgotPassword("admin@acme.example");
    await passwords.resetPassword({
      password: "a brand new admin passphrase",
      token: randomToken(random),
    });
    const { credential } = await repository.loadLoginMaterial("01K7ADM1N000000000000000P1");
    const verification = await verifyPasswordEqualized({
      encodedHash: credential?.data.passwordHash ?? "",
      password: "a brand new admin passphrase",
      profiles: [DEFAULT_PASSWORD_PROFILE],
    });
    expect(verification.matched).toBe(true);
  });

  test("leaves an existing administrator unchanged on a rerun", async () => {
    const { bootstrap, itemCount } = install();
    await bootstrap("admin@acme.example");
    const items = itemCount();

    expect(await bootstrap("ADMIN@acme.example")).toEqual({
      outcome: "unchanged",
      principalId: ulid("01K7ADM1N000000000000000P1"),
    });
    expect(itemCount()).toBe(items);
  });

  test("promotes a registered human and keeps their password", async () => {
    const { bootstrap, repository, securityEvents } = install();
    await registeredHuman(repository, { login: true });

    expect(await bootstrap("ops@acme.example")).toEqual({
      outcome: "promoted",
      principalId: ulid("01K7REG1STERED000000000000"),
    });
    expect((await repository.principalForId("01K7REG1STERED000000000000"))?.data).toMatchObject({
      platformRole: "administrator",
      updatedAt: "2026-10-09T04:02:10.000Z",
      version: 2,
    });
    expect(
      (await repository.loadLoginMaterial("01K7REG1STERED000000000000")).credential?.data,
    ).toMatchObject({ passwordHash: "scrypt-hash", version: 1 });
    expect(securityEvents()).toEqual([
      ["identity.platform-administrator-granted", "principal", 2, {}],
    ]);
    expect(await bootstrap("ops@acme.example")).toEqual({
      outcome: "unchanged",
      principalId: ulid("01K7REG1STERED000000000000"),
    });
  });

  test("refuses principals that cannot sign in", async () => {
    const withoutLogin = install();
    await registeredHuman(withoutLogin.repository, { login: false });
    expect(withoutLogin.bootstrap("ops@acme.example")).rejects.toThrow(
      "ops@acme.example has no complete password login; finish sign-up or reset the password, then run admin bootstrap again.",
    );

    const disabled = install();
    await registeredHuman(disabled.repository, { login: true, status: "disabled" });
    expect(disabled.bootstrap("ops@acme.example")).rejects.toThrow(
      "ops@acme.example belongs to a disabled human principal, not an active human.",
    );
  });
});
