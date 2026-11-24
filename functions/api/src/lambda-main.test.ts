import type { TenancyPersistence } from "@deployments-ai/db";
import { expect, test } from "bun:test";
import { makeRuntimeTenancyAuthorizer } from "./lambda-main.ts";

test("production tenancy authorization forwards exact HTTP mutation metadata", async () => {
  const seen: {
    mutation: boolean | undefined;
    operationName: string | undefined;
  }[] = [];
  const authorize = makeRuntimeTenancyAuthorizer({
    authorize: async (_invocation, operationName, mutation) => {
      seen.push({ mutation, operationName });
    },
  } as Pick<TenancyPersistence, "authorize">);

  await authorize(
    {
      body: {},
      identity: { principalId: "principal", scopes: ["schedules:write"] },
      query: {},
      scope: { organizationId: "organization" },
    },
    "pauseSchedule",
    true,
  );

  expect(seen).toEqual([{ mutation: true, operationName: "pauseSchedule" }]);
});
