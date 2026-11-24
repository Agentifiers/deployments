import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "bun:test";
import { makeOrganizationAuditEventRecord } from "../audit/organization-audit-log.ts";
import { makeDynamoDatabase, tableNamesFromEnvironment } from "../dynamo-database.ts";
import { makeIdGenerator } from "../ids.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import {
  makeOrganizationHoldReader,
  makeOrganizationStandingRepository,
  organizationNotStoppedCondition,
  organizationNotSuspendedCondition,
} from "./repository.ts";
import {
  BILLING,
  INSTALL_DEFAULTS,
  OPERATOR,
  holdKey,
  organizationRecord,
  readersMeetBeforeWriting,
} from "./test-support.ts";

const endpoint = process.env.AWS_ENDPOINT_URL_DYNAMODB;

describe.skipIf(!endpoint)("organization standing on local DynamoDB", () => {
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

  async function organization() {
    const organizationId = ids.generate();
    await client.send(
      new PutCommand({ Item: organizationRecord(organizationId), TableName: tableNames.control }),
    );
    return organizationId;
  }

  test("fails a transaction carrying the not-suspended condition while a hold exists", async () => {
    const organizationId = await organization();
    const standing = makeOrganizationStandingRepository({
      database,
      installDefaults: INSTALL_DEFAULTS,
    });
    const auditWhileFenced = async (action: string) => {
      const record = makeOrganizationAuditEventRecord({
        action,
        actor: { id: "01ARZ3NDEKTSV4RRFFQ69G5FB1", type: "principal" },
        eventId: ids.generate(),
        occurredAt: new Date().toISOString(),
        organizationId,
        resourceType: "organization",
      });
      const outcome = await database
        .transactWrite([organizationNotSuspendedCondition(organizationId), { kind: "put", record }])
        .then(
          () => "committed",
          (cause: unknown) => (isDatabaseWriteConflict(cause) ? "condition-failed" : cause),
        );
      const stored = await database.getRecord("events", { pk: record.pk, sk: record.sk }, true);
      return [action, outcome, stored !== undefined];
    };
    const hold = {
      actor: OPERATOR,
      key: holdKey("tos-review"),
      organizationId,
    };

    const beforeAnyStanding = await auditWhileFenced("before");
    await standing.placeHold({ ...hold, customerMessage: "Under review.", reason: "abuse" });
    const whileHeld = await auditWhileFenced("held");
    await standing.releaseHold(hold);
    const afterRelease = await auditWhileFenced("released");

    expect([beforeAnyStanding, whileHeld, afterRelease]).toEqual([
      ["before", "committed", true],
      ["held", "condition-failed", false],
      ["released", "committed", true],
    ]);
  });

  test("fails the not-stopped condition only while a stop hold exists, so payment holds drain", async () => {
    const organizationId = await organization();
    const standing = makeOrganizationStandingRepository({
      database,
      installDefaults: INSTALL_DEFAULTS,
    });
    const holds = makeOrganizationHoldReader(database);
    const renewWhileStopped = async (step: string) => {
      const record = makeOrganizationAuditEventRecord({
        action: step,
        actor: { id: "01ARZ3NDEKTSV4RRFFQ69G5FB1", type: "principal" },
        eventId: ids.generate(),
        occurredAt: new Date().toISOString(),
        organizationId,
        resourceType: "organization",
      });
      const outcome = await database
        .transactWrite([organizationNotStoppedCondition(organizationId), { kind: "put", record }])
        .then(
          () => "committed",
          (cause: unknown) => (isDatabaseWriteConflict(cause) ? "condition-failed" : cause),
        );
      const read = await holds.read(organizationId, { consistent: true });
      return [
        step,
        outcome,
        read.state === "suspended" ? read.holds.map((hold) => hold.reason) : [],
      ];
    };
    const payment = { actor: BILLING, key: holdKey("payment-overdue"), organizationId };
    const abuse = { actor: OPERATOR, key: holdKey("tos-review"), organizationId };

    const steps = [await renewWhileStopped("no standing")];
    await standing.placeHold({ ...payment, customerMessage: "Overdue.", reason: "payment" });
    steps.push(await renewWhileStopped("payment"));
    await standing.placeHold({ ...abuse, customerMessage: "Under review.", reason: "abuse" });
    steps.push(await renewWhileStopped("payment and abuse"));
    await standing.releaseHold(abuse);
    steps.push(await renewWhileStopped("abuse released"));
    await standing.releaseHold(payment);
    steps.push(await renewWhileStopped("all released"));

    expect(steps).toEqual([
      ["no standing", "committed", []],
      ["payment", "committed", ["payment"]],
      ["payment and abuse", "condition-failed", ["payment", "abuse"]],
      ["abuse released", "committed", ["payment"]],
      ["all released", "committed", []],
    ]);
  });

  test("lands holds two sources place at the same time and pages their history", async () => {
    const organizationId = await organization();
    const standing = makeOrganizationStandingRepository({
      database: readersMeetBeforeWriting(2)(database),
      installDefaults: INSTALL_DEFAULTS,
    });

    const outcomes = await Promise.all([
      standing.placeHold({
        actor: OPERATOR,
        customerMessage: "Under review.",
        key: holdKey("tos-review"),
        organizationId,
        reason: "abuse",
      }),
      standing.placeHold({
        actor: BILLING,
        customerMessage: "An invoice is overdue.",
        key: holdKey("payment-overdue"),
        organizationId,
        reason: "payment",
      }),
    ]);
    const final = await standing.read(organizationId, { consistent: true });
    const newest = await standing.listHistory({ limit: 1, organizationId });
    const older = await standing.listHistory({ before: 2, limit: 1, organizationId });
    const pastFirst = await standing.listHistory({ before: 1, limit: 1, organizationId });

    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["changed", "changed"]);
    expect(final.version).toBe(2);
    expect<unknown>(
      final.state === "suspended" && final.holds.map((hold) => hold.source).toSorted(),
    ).toEqual(["operator", "service:billing"]);
    expect(
      [newest, older, pastFirst].map((page) => [
        page.items.map((item) => [item.standingVersion, item.state]),
        page.before,
      ]),
    ).toEqual([
      [[[2, "suspended"]], 2],
      [[[1, "suspended"]], undefined],
      [[], undefined],
    ]);
  });
});
