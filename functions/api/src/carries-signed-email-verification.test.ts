import { type PlatformRecord } from "@deployments-ai/db";
import { expect, test } from "bun:test";
import {
  databaseWithRecords,
  environmentHierarchyRecords,
  PRINCIPAL_ID,
  storageKey,
} from "./application-auth-test-support.ts";
import { createApplicationAuthenticator } from "./application-auth.ts";

test("a platform token's signed email_verified claim reaches the request identity", async () => {
  const records = environmentHierarchyRecords();
  const principalKey = { pk: `PRINCIPAL#${PRINCIPAL_ID}`, sk: `PRINCIPAL#${PRINCIPAL_ID}` };
  records.set(storageKey("control", principalKey), {
    ...principalKey,
    data: { id: PRINCIPAL_ID, kind: "human", status: "active" },
    itemType: "principal",
  } as unknown as PlatformRecord);
  const authenticate = createApplicationAuthenticator({
    database: databaseWithRecords(records),
    jwt: {
      audience: "api",
      claimProfile: "platform",
      issuer: "https://auth.deployments.ai",
      verify: async (token) => ({
        email_verified: token.startsWith("verified."),
        scope: "organizations:write",
        sub: PRINCIPAL_ID,
      }),
    },
  });

  const identities = await Promise.all(
    ["verified.b.c", "unverified.b.c"].map((token) =>
      authenticate(
        new Request("https://api.example/v1/organizations", {
          headers: { authorization: `Bearer ${token}` },
          method: "POST",
        }),
      ),
    ),
  );

  expect(identities.map((identity) => identity?.emailVerified)).toEqual([true, undefined]);
});
