import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "bun:test";
import { makeDynamoDatabase, tableNamesFromEnvironment } from "../dynamo-database.ts";
import { makeFederationReads } from "../identity-federation/reads.ts";
import { makeIdGenerator } from "../ids.ts";
import { createWithClaims } from "../identity-federation/operations.ts";
import { signedUpPerson } from "../tenancy/organization-creation-test-support.ts";
import { makePrincipalStatusRepository } from "./principal-status.ts";

const endpoint = process.env.AWS_ENDPOINT_URL_DYNAMODB;

describe.skipIf(!endpoint)("principal status on local DynamoDB", () => {
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

  test("disables and re-enables a person through the identity transaction invariants", async () => {
    const person = ids.generate();
    await database.transactWrite(
      signedUpPerson(person).flatMap((record) =>
        record.itemType === "principal"
          ? createWithClaims(record, record.data.createdAt)
          : [{ kind: "put" as const, record }],
      ),
    );
    const statuses = makePrincipalStatusRepository({ database });
    const reads = makeFederationReads(database);
    const change = { actorPrincipalId: ids.generate(), principalId: person, reason: "Review" };
    const signInState = async () => {
      const [principal, security, fence] = await Promise.all([
        reads.principal(person),
        reads.securityState(person),
        reads.bffFence(person),
      ]);
      return [
        principal?.data.status,
        security?.data.sessionEpoch,
        fence?.data.principalStatus,
        fence?.data.sessionEpoch,
      ];
    };

    const disabled = await statuses.setStatus({ ...change, status: "disabled" });
    const afterDisable = await signInState();
    const repeated = await statuses.setStatus({ ...change, status: "disabled" });
    const enabled = await statuses.setStatus({ ...change, status: "active" });

    expect([disabled.changed, repeated.changed, enabled.changed]).toEqual([true, false, true]);
    expect([afterDisable, await signInState()]).toEqual([
      ["disabled", 4, "disabled", 4],
      ["active", 4, "active", 4],
    ]);
  });
});
