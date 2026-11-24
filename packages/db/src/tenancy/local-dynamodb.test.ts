import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "bun:test";
import { makeDynamoDatabase, tableNamesFromEnvironment } from "../dynamo-database.ts";
import { makeIdGenerator } from "../ids.ts";
import { tableForItemType } from "../records/index.ts";
import { makeTenancyPersistence } from "../tenancy-persistence-composition.ts";
import {
  createAs,
  creatorsMeetBeforeWriting,
  signedUpPerson,
} from "./organization-creation-test-support.ts";

const endpoint = process.env.AWS_ENDPOINT_URL_DYNAMODB;

describe.skipIf(!endpoint)("organization creation fences on local DynamoDB", () => {
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      ...(endpoint ? { endpoint } : {}),
      region: process.env.AWS_REGION ?? "us-east-1",
    }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
  const tableNames = tableNamesFromEnvironment();
  const database = makeDynamoDatabase(client, tableNames);
  const ids = makeIdGenerator();

  test("admits exactly one of two concurrent creates at one below the quota", async () => {
    const person = ids.generate();
    for (const record of signedUpPerson(person)) {
      await client.send(
        new PutCommand({ Item: record, TableName: tableNames[tableForItemType(record.itemType)] }),
      );
    }
    const policy = { quotaPerPrincipal: 2, requireVerifiedEmail: true };
    const tenancy = makeTenancyPersistence({ database, organizationCreation: policy });
    const racing = makeTenancyPersistence({
      database: creatorsMeetBeforeWriting(2)(database),
      organizationCreation: policy,
    });
    await tenancy.organizations.create(createAs(person, `First ${person}`));

    const outcomes = await Promise.all(
      [`Racer A ${person}`, `Racer B ${person}`].map((name) =>
        racing.organizations.create(createAs(person, name)).then(
          () => "created",
          (cause: { readonly code: string }) => cause.code,
        ),
      ),
    );
    const count = await database.getRecord(
      "control",
      { pk: `PRINCIPAL#${person}`, sk: "PRINCIPAL-ORGANIZATION-CREATIONS" },
      true,
    );

    expect(outcomes.toSorted()).toEqual(["created", "organization_quota_reached"]);
    expect(count?.itemType === "principal-organization-creations" && count.data).toMatchObject({
      organizationsCreated: 2,
      version: 2,
    });
  });
});
