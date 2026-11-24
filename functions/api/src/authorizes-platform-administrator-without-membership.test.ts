import { type PlatformRecord } from "@deployments-ai/db";
import { openOperatorAccessRecord } from "@deployments-ai/db/operator-access-testing";
import { describe, expect, test } from "bun:test";
import {
  databaseWithRecords,
  ENVIRONMENT_ID,
  environmentHierarchyRecords,
  ORGANIZATION_ID,
  PRINCIPAL_ID,
  PROJECT_ID,
  storageKey,
} from "./application-auth-test-support.ts";
import { createApplicationAuthenticator, OperatorAccessRequiredError } from "./application-auth.ts";

const OTHER_ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB9";

function administratorRecords(options: { readonly member?: boolean } = {}) {
  const records = environmentHierarchyRecords();
  if (!options.member) {
    records.delete(
      storageKey("control", {
        pk: `ORG#${ORGANIZATION_ID}`,
        sk: `ORGANIZATION-MEMBER#${PRINCIPAL_ID}`,
      }),
    );
  }
  const principalKey = { pk: `PRINCIPAL#${PRINCIPAL_ID}`, sk: `PRINCIPAL#${PRINCIPAL_ID}` };
  records.set(storageKey("control", principalKey), {
    ...principalKey,
    data: { id: PRINCIPAL_ID, kind: "human", platformRole: "administrator", status: "active" },
    itemType: "principal",
  } as unknown as PlatformRecord);
  return records;
}

function withAccess(records: Map<string, PlatformRecord>, organizationId: string) {
  const access = openOperatorAccessRecord({ organizationId, principalId: PRINCIPAL_ID });
  records.set(storageKey("control", access), access);
  return records;
}

function authenticate(records: Map<string, PlatformRecord>, scope = "governance:read") {
  return createApplicationAuthenticator({
    database: databaseWithRecords(records),
    jwt: {
      audience: "api",
      claimProfile: "platform",
      issuer: "https://auth.deployments.ai",
      verify: async () => ({ sub: PRINCIPAL_ID, scope }),
    },
  })(
    new Request("https://api.example/v1/governance", {
      headers: { authorization: "Bearer a.b.c", "x-deployments-environment": ENVIRONMENT_ID },
    }),
  );
}

describe("platform administrators on tenant data", () => {
  test("are refused with operator_access_required without open operator access", async () => {
    const refused = await authenticate(administratorRecords()).catch((cause: unknown) => cause);
    expect(refused).toBeInstanceOf(OperatorAccessRequiredError);
    expect(refused).toMatchObject({ organizationId: ORGANIZATION_ID });
  });

  test("are refused when their open access is for another organization", async () => {
    expect(
      authenticate(withAccess(administratorRecords(), OTHER_ORGANIZATION_ID)),
    ).rejects.toBeInstanceOf(OperatorAccessRequiredError);
  });

  test("cross membership boundaries under open operator access to the organization", async () => {
    expect(await authenticate(withAccess(administratorRecords(), ORGANIZATION_ID))).toMatchObject({
      environmentIds: [ENVIRONMENT_ID],
      operatorAccess: { organizationId: ORGANIZATION_ID },
      organizationIds: [ORGANIZATION_ID],
      platformRole: "administrator",
      projectIds: [PROJECT_ID],
    });
  });

  test("a platform-wide scope on a signed-in token is held to the same rule", async () => {
    expect(authenticate(administratorRecords(), "platform:admin")).rejects.toBeInstanceOf(
      OperatorAccessRequiredError,
    );
  });

  test("act as members, without the platform role, where they are active members", async () => {
    const identity = await authenticate(
      administratorRecords({ member: true }),
      "platform:admin governance:read",
    );
    expect(identity).toMatchObject({ scopes: ["governance:read"] });
    expect(identity).not.toHaveProperty("platformRole");
    expect(identity).not.toHaveProperty("operatorAccess");
  });
});
