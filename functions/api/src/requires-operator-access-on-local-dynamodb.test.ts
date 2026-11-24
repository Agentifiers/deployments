import {
  makeIdGenerator,
  makeOperatorAccessRepository,
  OrganizationRecord,
  PrincipalRecord,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import {
  DYNAMODB_LOCAL_ENDPOINT,
  localPlatformTables,
} from "@deployments-ai/db/operator-access-testing";
import { standingInstallation } from "@deployments-ai/organization-admission/testing";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { createApiLambdaHandler, makeApiFoundation } from "./api-lambda-foundation.ts";
import { createApplicationAuthenticator } from "./application-auth.ts";
import { createTenancyApi, type TenancyApiService } from "./index.ts";

const AT = "2026-01-01T00:00:00.000Z";

const unusedService = new Proxy(
  {},
  {
    get: () =>
      new Proxy(
        {},
        {
          get: () => async () => {
            throw new Error("Unexpected service operation.");
          },
        },
      ),
  },
) as TenancyApiService;

describe.skipIf(!DYNAMODB_LOCAL_ENDPOINT)(
  "control-plane API operator access on DynamoDB Local",
  () => {
    const ids = makeIdGenerator();
    const organizationId = ids.generate();
    const administrator = ids.generate();
    let tables: Awaited<ReturnType<typeof localPlatformTables>>;

    beforeAll(async () => {
      tables = await localPlatformTables(DYNAMODB_LOCAL_ENDPOINT!);
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
      ]);
    });

    afterAll(async () => {
      await tables?.drop();
    });

    function whoami() {
      const handler = createApiLambdaHandler(
        ({ authenticate }) =>
          createTenancyApi({
            authenticate,
            authorize: async () => undefined,
            idempotency: { execute: async (input) => input.operation() },
            service: unusedService,
          }),
        {
          dependencies: () => ({
            foundation: {
              ...makeApiFoundation({
                DEPLOYMENTS_AI_API_JWT_AUDIENCE: "api",
                DEPLOYMENTS_AI_API_JWT_ISSUER: "https://auth.example.test",
              }),
              authenticate: createApplicationAuthenticator({
                database: tables.database,
                jwt: {
                  audience: "api",
                  claimProfile: "platform",
                  issuer: "https://auth.example.test",
                  verify: async () => ({ scope: "members:read", sub: administrator }),
                },
              }),
            },
            gate: standingInstallation({ organizationId }).gate,
          }),
        },
      );
      return handler({
        headers: { authorization: "Bearer a.b.c", "x-deployments-organization": organizationId },
        rawPath: "/v1/whoami",
        requestContext: { domainName: "api.example.test", http: { method: "GET" } },
      }).then((result) => ({
        body: JSON.parse(result.body) as Record<string, unknown>,
        status: result.statusCode,
      }));
    }

    test("refuses an administrator without operator access and admits one with it", async () => {
      expect(await whoami()).toMatchObject({
        body: { code: "operator_access_required", organizationId },
        status: 403,
      });

      const access = makeOperatorAccessRepository({ database: tables.database });
      await access.open({ organizationId, principalId: administrator, reason: "Support case" });
      expect(await whoami()).toMatchObject({
        body: { organizationId, platformRole: "administrator" },
        status: 200,
      });

      await access.close({ organizationId, principalId: administrator });
      expect((await whoami()).status).toBe(403);
    });
  },
);
