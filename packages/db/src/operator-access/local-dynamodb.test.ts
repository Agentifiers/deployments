import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { organizationAccess } from "../identity-federation/access.ts";
import { makeIdGenerator, Ulid } from "../ids.ts";
import { listOrganizationAuditEventPage } from "../audit/organization-audit-log.ts";
import { organizationRecord } from "../organization-standing/test-support.ts";
import { authorizePlatformHumanScope } from "../platform-human-authorization.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { EnvironmentRecord, PrincipalRecord } from "../records/control.ts";
import { UniqueClaimRecord } from "../records/identity.ts";
import { makeUniqueClaimRecord, uniqueClaimRequirements } from "../unique-claims.ts";
import { DYNAMODB_LOCAL_ENDPOINT, localPlatformTables } from "./local-dynamodb.fixture.ts";
import { makeOperatorAccessRepository } from "./repository.ts";

const AT = "2026-01-01T00:00:00.000Z";

describe.skipIf(!DYNAMODB_LOCAL_ENDPOINT)("operator access on DynamoDB Local", () => {
  const ids = makeIdGenerator();
  let tables: Awaited<ReturnType<typeof localPlatformTables>>;
  const organizationId = ids.generate();
  const projectId = ids.generate();
  const environmentId = ids.generate();
  const administrator = ids.generate();

  beforeAll(async () => {
    tables = await localPlatformTables(DYNAMODB_LOCAL_ENDPOINT!);
    const principal = Schema.decodeUnknownSync(PrincipalRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: AT,
          id: administrator,
          kind: "human",
          platformRole: "administrator",
          primaryEmail: "operator@example.test",
          status: "active",
          updatedAt: AT,
          version: 1,
        },
        itemType: "principal" as const,
      }),
    );
    const environment = Schema.decodeUnknownSync(EnvironmentRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: AT,
          id: environmentId,
          kind: "production",
          name: "Production",
          organizationId,
          projectId,
          slug: "production",
          status: "active",
          updatedAt: AT,
          version: 1,
        },
        itemType: "environment" as const,
      }),
    );
    const claims = uniqueClaimRequirements(environment).map((claim) =>
      Schema.decodeUnknownSync(UniqueClaimRecord)(makeUniqueClaimRecord(claim, AT)),
    );
    await tables.seed([organizationRecord(organizationId), principal, environment, ...claims]);
  });

  afterAll(async () => {
    await tables?.drop();
  });

  test("refuses an administrator without access, admits with it, and audits the grant", async () => {
    const scope = { environmentId, organizationId, principalId: administrator, projectId };
    const control = () =>
      organizationAccess(tables.database, {
        organizationId,
        platformAdministrator: true,
        principalId: administrator,
      });
    expect((await control()).kind).toBe("operator-access-required");
    expect((await authorizePlatformHumanScope(tables.database, scope)).kind).toBe(
      "operator-access-required",
    );

    const operatorAccess = makeOperatorAccessRepository({ database: tables.database });
    const opened = await operatorAccess.open({
      organizationId,
      principalId: administrator,
      reason: "Investigating a failed run",
      ticket: "SUP-7",
    });
    // A retried open converges on the same grant.
    const retried = await operatorAccess.open({
      organizationId,
      principalId: administrator,
      reason: "Investigating a failed run",
    });
    expect(retried).toMatchObject({ access: { grantId: opened.access.grantId }, kind: "renewed" });

    expect(await control()).toMatchObject({
      kind: "platform-administrator",
      operatorAccess: { grantId: opened.access.grantId, organizationId },
    });
    expect(await authorizePlatformHumanScope(tables.database, scope)).toMatchObject({
      kind: "platform-administrator",
    });
    expect((await operatorAccess.listOpen({})).items.map((item) => item.organizationId)).toContain(
      organizationId,
    );

    expect(
      await operatorAccess.close({ organizationId, principalId: administrator }),
    ).toMatchObject({ changed: true });
    expect((await control()).kind).toBe("operator-access-required");

    const audit = await listOrganizationAuditEventPage(tables.database, {
      limit: 10,
      organizationId,
    });
    expect(
      audit.items
        .map((event) => [event.data.action, event.data.actor.id ?? ""])
        .toSorted((left, right) => left.join(" ").localeCompare(right.join(" "))),
    ).toEqual([
      ["organization.operator-access-closed", administrator],
      ["organization.operator-access-opened", administrator],
      ["organization.operator-access-renewed", administrator],
    ]);
    expect(Schema.is(Ulid)(audit.items[0]?.data.changes?.grantId)).toBe(true);
  });
});
