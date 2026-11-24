import { describe, expect, test } from "bun:test";
import { replaceWithClaims } from "../identity-federation/administration-context.ts";
import { createWithClaims } from "../identity-federation/operations.ts";
import type { DirectoryToken } from "../records/directory.ts";
import { uniqueClaimRequirements } from "../unique-claims.ts";
import { directoryRecord } from "./record-builders.ts";
import { directoryHarness, OWNER, ulid } from "./test-support.ts";

const ORGANIZATION = ulid("01ARZ3NDEKTSV4RRFFQ69G5FC0");
const PRINCIPAL = ulid("01ARZ3NDEKTSV4RRFFQ69G5FC4");
const AT = "2026-10-08T12:00:00.000Z";

function token(id: string, tokenHash: string): DirectoryToken {
  return { createdAt: AT, createdBy: OWNER, id: ulid(id), tokenHash, tokenPrefix: "dpl_scim_ab" };
}

function directory(tokens: readonly DirectoryToken[]) {
  return directoryRecord("organization-directory", {
    createdAt: AT,
    defaultRole: "member",
    id: ORGANIZATION,
    organizationId: ORGANIZATION,
    tokens,
    updatedAt: AT,
    version: 1,
  });
}

function directoryUser(organizationId = ORGANIZATION) {
  return directoryRecord("organization-directory-user", {
    createdAt: AT,
    externalId: "00u1abcd",
    id: PRINCIPAL,
    organizationId,
    origin: "provisioned",
    updatedAt: AT,
    userName: "Ada@Acme.Example",
    version: 1,
  });
}

describe("directory records", () => {
  test("the directory lives in its organization's partition and holds at most two tokens", () => {
    const record = directory([
      token("01ARZ3NDEKTSV4RRFFQ69G5FD0", "hash-a"),
      token("01ARZ3NDEKTSV4RRFFQ69G5FD1", "hash-b"),
    ]);
    expect([record.pk, record.sk]).toEqual([
      `ORG#${ORGANIZATION}`,
      `ORGANIZATION-DIRECTORY#${ORGANIZATION}`,
    ]);
    expect(() =>
      directory([
        token("01ARZ3NDEKTSV4RRFFQ69G5FD0", "hash-a"),
        token("01ARZ3NDEKTSV4RRFFQ69G5FD1", "hash-b"),
        token("01ARZ3NDEKTSV4RRFFQ69G5FD2", "hash-c"),
      ]),
    ).toThrow();
    expect(() =>
      directoryRecord("organization-directory", { ...directory([]).data, id: PRINCIPAL }),
    ).toThrow();
  });

  test("each token claims its hash globally and each user claims its names in its organization", () => {
    const tokens = directory([
      token("01ARZ3NDEKTSV4RRFFQ69G5FD0", "hash-a"),
      token("01ARZ3NDEKTSV4RRFFQ69G5FD1", "hash-b"),
    ]);
    expect(
      uniqueClaimRequirements(tokens).map((claim) => [claim.namespace, claim.value, claim.ownerId]),
    ).toEqual([
      ["directory-token-hash", "hash-a", ORGANIZATION],
      ["directory-token-hash", "hash-b", ORGANIZATION],
    ]);

    const user = directoryUser();
    expect([user.pk, user.sk]).toEqual([
      `ORG#${ORGANIZATION}`,
      `ORGANIZATION-DIRECTORY-USER#${PRINCIPAL}`,
    ]);
    expect(uniqueClaimRequirements(user).map((claim) => [claim.namespace, claim.value])).toEqual([
      [
        `organization:${ORGANIZATION}:directory-user-name`,
        "2a1322415fff1b1aceaebe7855b2c5bd6e9efa5e787d46391f971aea65062ce3",
      ],
      [
        `organization:${ORGANIZATION}:directory-external-id`,
        "8def678da0d076709ba70363cfd39c8775be6b321b00c332a189f8a2860d6470",
      ],
    ]);
  });

  test("a stored user mapping reads back and keeps its origin across updates", async () => {
    const { acme, database } = await directoryHarness();
    const user = directoryUser(acme);
    await database.transactWrite(createWithClaims(user, AT));
    expect(await database.getRecord("control", { pk: user.pk, sk: user.sk }, true)).toEqual(user);

    const renamed = directoryRecord("organization-directory-user", {
      ...user.data,
      updatedAt: "2026-10-08T12:01:00.000Z",
      userName: "grace@acme.example",
      version: 2,
    });
    await database.transactWrite(replaceWithClaims(user, renamed, renamed.data.updatedAt));
    const claim = await database.getRecord(
      "control",
      {
        pk: `UNIQUE#${encodeURIComponent(`organization:${acme}:directory-user-name`)}`,
        sk: "VALUE#769e43c912f220ed26d2898ca1686b29c708e4b56e23b729996a0215916b187b",
      },
      true,
    );
    expect(claim?.itemType).toBe("unique-claim");

    const adopted = directoryRecord("organization-directory-user", {
      ...renamed.data,
      origin: "adopted",
      updatedAt: "2026-10-08T12:02:00.000Z",
      version: 3,
    });
    expect(
      await database
        .transactWrite([{ kind: "put", previousRecord: renamed, record: adopted }])
        .then(
          () => "written",
          (error: Error) => error.cause,
        ),
    ).toBe("previousRecord must identify the same resource as the replacement record.");
  });
});
