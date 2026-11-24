import { describe, expect, test } from "bun:test";
import { PersistenceError } from "../persistence-types.ts";
import { makeDirectory } from "./index.ts";
import { directoryHarness, NOW, OWNER, RIVAL, storedRecords } from "./test-support.ts";

async function setup() {
  const harness = await directoryHarness();
  const secrets = ["first-secret", "second-secret", "third-secret"];
  const directory = makeDirectory({
    database: harness.database,
    now: () => NOW,
    randomSecret: () => secrets.shift() ?? "spare-secret",
  });
  return {
    ...harness,
    acmeAdmin: { organizationId: harness.acme, principalId: OWNER },
    directory,
    rivalAdmin: { organizationId: harness.rival, principalId: RIVAL },
  };
}

async function failure(work: Promise<unknown>) {
  try {
    await work;
  } catch (cause) {
    if (cause instanceof PersistenceError) return { code: cause.code, kind: cause.kind };
    throw cause;
  }
  throw new Error("Expected a persistence failure.");
}

describe("directory administration", () => {
  test("an organization has no directory until an administrator sets its default role", async () => {
    const { acme, acmeAdmin, directory } = await setup();
    expect(await failure(directory.getSettings(acme))).toEqual({
      code: "directory_not_configured",
      kind: "not-found",
    });
    expect(await failure(directory.issueToken(acmeAdmin))).toEqual({
      code: "directory_not_configured",
      kind: "not-found",
    });

    await directory.putSettings(acmeAdmin, { defaultRole: "viewer" });
    await directory.putSettings(acmeAdmin, { defaultRole: "member" });
    expect(await directory.getSettings(acme)).toEqual({
      createdAt: "2026-10-08T12:00:00.000Z",
      defaultRole: "member",
      tokens: [],
      updatedAt: "2026-10-08T12:00:00.000Z",
    });
  });

  test("an issued token authenticates its organization until it is revoked", async () => {
    const { acme, acmeAdmin, directory, fake } = await setup();
    await directory.putSettings(acmeAdmin, { defaultRole: "member" });

    const issued = await directory.issueToken(acmeAdmin);
    expect(issued.secret).toBe("dpl_scim_first-secret");
    expect(issued.token).toEqual({
      createdAt: "2026-10-08T12:00:00.000Z",
      createdBy: OWNER,
      id: issued.token.id,
      tokenPrefix: "dpl_scim_first-s",
    });
    expect(issued.settings.tokens).toEqual([issued.token]);
    expect(await directory.authenticate(issued.secret)).toEqual({
      organizationId: acme,
      tokenId: issued.token.id,
    });

    const revoked = await directory.revokeToken(acmeAdmin, issued.token.id);
    expect(revoked.tokens).toEqual([]);
    expect(await directory.authenticate(issued.secret)).toBeUndefined();
    expect(await failure(directory.revokeToken(acmeAdmin, issued.token.id))).toEqual({
      code: "directory_token_not_found",
      kind: "not-found",
    });

    const events = storedRecords(fake, "events", "semantic-event")
      .filter((event) => event.data.aggregateType === "organization-directory")
      .map((event) => [event.data.eventType, event.data.payload]);
    expect(events).toEqual([
      ["organization-directory.created", { defaultRole: "member" }],
      [
        "organization-directory.token-issued",
        { tokenId: issued.token.id, tokenPrefix: "dpl_scim_first-s" },
      ],
      [
        "organization-directory.token-revoked",
        { tokenId: issued.token.id, tokenPrefix: "dpl_scim_first-s" },
      ],
    ]);
    expect(
      storedRecords(fake, "events", "audit-event")
        .filter((audit) => audit.data.resourceType === "organization-directory")
        .map((audit) => [audit.data.action, audit.data.actor]),
    ).toEqual([
      ["organization-directory.created", { id: OWNER, type: "principal" }],
      ["organization-directory.token-issued", { id: OWNER, type: "principal" }],
      ["organization-directory.token-revoked", { id: OWNER, type: "principal" }],
    ]);
  });

  test("a directory holds at most two tokens", async () => {
    const { acmeAdmin, directory } = await setup();
    await directory.putSettings(acmeAdmin, { defaultRole: "member" });
    await directory.issueToken(acmeAdmin);
    await directory.issueToken(acmeAdmin);
    expect(await failure(directory.issueToken(acmeAdmin))).toEqual({
      code: "directory_token_limit",
      kind: "conflict",
    });
  });

  test("only an exact issued token authenticates, and only for its own organization", async () => {
    const { acme, acmeAdmin, directory, rival, rivalAdmin } = await setup();
    await directory.putSettings(acmeAdmin, { defaultRole: "member" });
    await directory.putSettings(rivalAdmin, { defaultRole: "viewer" });
    const acmeToken = await directory.issueToken(acmeAdmin);
    const rivalToken = await directory.issueToken(rivalAdmin);

    expect(
      await Promise.all(
        [acmeToken.secret, rivalToken.secret, `${acmeToken.secret}x`, "dpl_first-secret"].map(
          (secret) => directory.authenticate(secret),
        ),
      ),
    ).toEqual([
      { organizationId: acme, tokenId: acmeToken.token.id },
      { organizationId: rival, tokenId: rivalToken.token.id },
      undefined,
      undefined,
    ]);
  });

  test("two concurrent token issues leave exactly one token", async () => {
    const { acme, acmeAdmin, directory } = await setup();
    await directory.putSettings(acmeAdmin, { defaultRole: "member" });

    const outcomes = await Promise.all([
      directory.issueToken(acmeAdmin).then(
        () => "issued",
        (cause: PersistenceError) => cause.code,
      ),
      directory.issueToken(acmeAdmin).then(
        () => "issued",
        (cause: PersistenceError) => cause.code,
      ),
    ]);
    expect(outcomes.toSorted()).toEqual(["directory_conflict", "issued"]);
    expect((await directory.getSettings(acme)).tokens).toHaveLength(1);
  });
});
