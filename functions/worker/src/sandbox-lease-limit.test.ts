import { describe, expect, it } from "bun:test";
import { organizationHolds } from "@deployments-ai/organization-admission/testing";
import { id, inMemoryDatabase } from "./agent-run.fixture.ts";
import { sandboxLeaseLimit } from "./sandbox-lease-limit.ts";

describe("sandbox lease limit", () => {
  it("resolves to zero slots under any hold and to the plan limit after release", async () => {
    const memory = inMemoryDatabase([]);
    const organizationId = id(1);
    const holds = organizationHolds(memory.database, organizationId);
    const limit = sandboxLeaseLimit(memory.database, async () => 3);

    const active = await limit(organizationId);
    await holds.hold("payment");
    const underPayment = await limit(organizationId);
    await holds.hold("abuse");
    await holds.release("payment");
    const underAbuse = await limit(organizationId);
    await holds.release("abuse");

    expect([active, underPayment, underAbuse, await limit(organizationId)]).toEqual([3, 0, 0, 3]);
  });

  it("fails the lease when standing cannot be read", async () => {
    const memory = inMemoryDatabase([]);
    const limit = sandboxLeaseLimit(
      {
        ...memory.database,
        getRecord: async () => {
          throw new Error("DynamoDB is unavailable.");
        },
      },
      async () => 3,
    );

    expect(limit(id(1))).rejects.toThrow("DynamoDB is unavailable.");
  });
});
