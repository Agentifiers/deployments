import {
  EnvironmentRecord,
  makeIdGenerator,
  makeOperatorAccessRepository,
  makeUniqueClaimRecord,
  OrganizationRecord,
  PrincipalRecord,
  uniqueClaimRequirements,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import {
  DYNAMODB_LOCAL_ENDPOINT,
  localPlatformTables,
} from "@deployments-ai/db/operator-access-testing";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { audience, startJwtIssuer, type JwtIssuer } from "./runtime-human-access.fixture.ts";
import { createRuntimeHumanAuthenticator } from "./runtime-authentication.ts";

const AT = "2026-01-01T00:00:00.000Z";

describe.skipIf(!DYNAMODB_LOCAL_ENDPOINT)("runtime API operator access on DynamoDB Local", () => {
  const ids = makeIdGenerator();
  const organizationId = ids.generate();
  const projectId = ids.generate();
  const environmentId = ids.generate();
  const administrator = ids.generate();
  let tables: Awaited<ReturnType<typeof localPlatformTables>>;
  let jwt: JwtIssuer;

  beforeAll(async () => {
    jwt = await startJwtIssuer();
    tables = await localPlatformTables(DYNAMODB_LOCAL_ENDPOINT!);
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
    await tables.seed([
      Schema.decodeUnknownSync(OrganizationRecord)(
        withCanonicalRecordKeys({
          data: {
            createdAt: AT,
            id: organizationId,
            name: "Acme",
            slug: `acme-${organizationId.toLowerCase()}`,
            status: "active",
            updatedAt: AT,
            version: 1,
          },
          itemType: "organization" as const,
        }),
      ),
      Schema.decodeUnknownSync(PrincipalRecord)(
        withCanonicalRecordKeys({
          data: {
            createdAt: AT,
            id: administrator,
            kind: "human",
            platformRole: "administrator",
            status: "active",
            updatedAt: AT,
            version: 1,
          },
          itemType: "principal" as const,
        }),
      ),
      environment,
      ...uniqueClaimRequirements(environment).map(
        (claim) => makeUniqueClaimRecord(claim, AT) as PlatformRecord,
      ),
    ]);
  });

  afterAll(async () => {
    await jwt?.stop();
    await tables?.drop();
  });

  async function authenticate() {
    const human = createRuntimeHumanAuthenticator({
      database: tables.database,
      jwt: { audience, claimProfile: "platform", issuer: jwt.issuer },
    });
    return human(await jwt.token({ scope: "runs:read", subject: administrator }), {
      "x-deployments-environment": environmentId,
      "x-deployments-organization": organizationId,
      "x-deployments-project": projectId,
    }).catch((cause: unknown) => cause);
  }

  test("refuses an administrator without operator access and admits one with it", async () => {
    expect(await authenticate()).toMatchObject({ code: "operator_access_required", status: 403 });

    const access = makeOperatorAccessRepository({ database: tables.database });
    const opened = await access.open({
      organizationId,
      principalId: administrator,
      reason: "Support case",
    });
    expect(await authenticate()).toMatchObject({
      kind: "human",
      operatorAccessGrantId: opened.access.grantId,
      platformAdministrator: true,
      principalId: administrator,
    });
  });
});
