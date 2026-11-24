import { describe, expect, test } from "bun:test";
import { DatabaseError, type DynamoDatabaseService } from "../client-types.ts";
import { evaluationMemoryDatabase } from "../evaluations/memory-database.fixture.ts";
import { makeOrganizationDataBoundaryReader } from "./data-boundary.ts";
import { makeOrganizationStandingRepository } from "./repository.ts";
import {
  INSTALL_DEFAULTS,
  OPEN_BOUNDARY,
  OPERATOR,
  ORGANIZATION_ID,
  minuteClock,
  organizationRecord,
} from "./test-support.ts";

describe("organization data boundary reader", () => {
  test("reads the boundary an operator set, strongly consistent", async () => {
    const memory = evaluationMemoryDatabase([organizationRecord(ORGANIZATION_ID)]);
    const reads: (boolean | undefined)[] = [];
    const reader = makeOrganizationDataBoundaryReader({
      ...memory.database,
      getRecord: (table, recordKey, consistent) => {
        reads.push(consistent);
        return memory.database.getRecord(table, recordKey, consistent);
      },
    });
    const before = await reader.read(ORGANIZATION_ID);
    await makeOrganizationStandingRepository({
      database: memory.database,
      installDefaults: INSTALL_DEFAULTS,
      now: minuteClock(),
    }).setDataBoundary({
      actor: OPERATOR,
      operatorNote: "BAA-2026-17",
      organizationId: ORGANIZATION_ID,
      profile: "phi",
    });

    const after = await reader.read(ORGANIZATION_ID);

    expect(before).toEqual(OPEN_BOUNDARY);
    expect(after.profile).toBe("phi");
    expect(reads).toEqual([true, true]);
  });

  test("propagates a read error instead of reading the boundary as open", async () => {
    const failure = new DatabaseError({
      cause: "ProvisionedThroughputExceededException",
      message: "throttled",
      operation: "get",
      reason: "unknown",
      table: "control",
    });
    const database = {
      ...evaluationMemoryDatabase([]).database,
      getRecord: () => Promise.reject(failure),
    } satisfies DynamoDatabaseService;

    expect(makeOrganizationDataBoundaryReader(database).read(ORGANIZATION_ID)).rejects.toBe(
      failure,
    );
  });
});
