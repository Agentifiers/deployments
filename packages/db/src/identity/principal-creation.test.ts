import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { DEFAULT_TABLE_NAMES } from "../client-types.ts";
import { makeDynamoDatabase } from "../dynamo-database.ts";
import { Ulid } from "../ids.ts";
import { fakeDynamoDocumentClient } from "../testing/dynamo-document-client.fixture.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import { newHumanPrincipalOperations } from "./principal-creation.ts";

const id = Schema.decodeUnknownSync(Ulid);
const PRINCIPAL_ID = id("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const AT = "2026-10-01T12:00:00.000Z";

function setup() {
  const dynamo = fakeDynamoDocumentClient();
  return { database: makeDynamoDatabase(dynamo.client, DEFAULT_TABLE_NAMES), dynamo };
}

describe("newHumanPrincipalOperations", () => {
  test("an unverified principal is created active at session epoch 0 with no proven mailbox", async () => {
    const { database, dynamo } = setup();

    await database.transactWrite(
      newHumanPrincipalOperations({
        createdAt: AT,
        displayName: "Ada Lovelace",
        eventId: id("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
        mailbox: "unverified",
        primaryEmail: "ada@example.com",
        principalId: PRINCIPAL_ID,
      }),
    );

    expect(
      dynamo
        .items("identity")
        .toSorted((left, right) => String(left.itemType).localeCompare(String(right.itemType)))
        .map((item) => [item.itemType, item.data]),
    ).toEqual([
      [
        "identity-bff-revocation-fence",
        {
          createdAt: AT,
          id: PRINCIPAL_ID,
          principalId: PRINCIPAL_ID,
          principalStatus: "active",
          sessionEpoch: 0,
          updatedAt: AT,
          version: 1,
        },
      ],
      [
        "principal-security-state",
        {
          createdAt: AT,
          credentialVersion: 0,
          id: "current",
          principalId: PRINCIPAL_ID,
          sessionEpoch: 0,
          updatedAt: AT,
          version: 1,
        },
      ],
    ]);
    expect(
      dynamo
        .items("control")
        .filter((item) => item.itemType === "principal")
        .map((item) => item.data),
    ).toEqual([
      {
        createdAt: AT,
        displayName: "Ada Lovelace",
        id: PRINCIPAL_ID,
        kind: "human",
        primaryEmail: "ada@example.com",
        status: "active",
        updatedAt: AT,
        version: 1,
      },
    ]);
  });

  test("a verified principal records its mailbox as proven when it was created", async () => {
    const { database, dynamo } = setup();

    await database.transactWrite(
      newHumanPrincipalOperations({
        createdAt: AT,
        eventId: id("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
        mailbox: "verified",
        primaryEmail: "ada@example.com",
        principalId: PRINCIPAL_ID,
      }),
    );

    expect(
      dynamo
        .items("identity")
        .filter((item) => item.itemType === "principal-security-state")
        .map((item) => item.data),
    ).toEqual([expect.objectContaining({ emailVerifiedAt: AT })]);
  });

  test("a second principal cannot take an email another principal holds", async () => {
    const { database } = setup();
    await database.transactWrite(
      newHumanPrincipalOperations({
        createdAt: AT,
        eventId: id("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
        mailbox: "unverified",
        primaryEmail: "ada@example.com",
        principalId: PRINCIPAL_ID,
      }),
    );

    const second = database.transactWrite(
      newHumanPrincipalOperations({
        createdAt: AT,
        eventId: id("01ARZ3NDEKTSV4RRFFQ69G5FAY"),
        mailbox: "unverified",
        primaryEmail: "ada@example.com",
        principalId: id("01ARZ3NDEKTSV4RRFFQ69G5FAX"),
      }),
    );

    expect(
      await second.then(
        () => "created",
        (error) => isDatabaseWriteConflict(error),
      ),
    ).toBe(true);
  });
});
