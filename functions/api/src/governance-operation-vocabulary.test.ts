import { describe, expect, expectTypeOf, test } from "bun:test";
import {
  ConversationErasureCounts,
  ConversationErasurePhase,
  GOVERNANCE_OPERATION_KINDS,
} from "@deployments-ai/api-contract";
import {
  CONVERSATION_ERASURE_PHASES as STORED_PHASES,
  ConversationErasureCounts as StoredCounts,
  GOVERNANCE_OPERATION_KINDS as STORED_KINDS,
} from "@deployments-ai/db";

describe("governance operation vocabulary", () => {
  test("the public contract names exactly the stored kinds, phases, and counts", () => {
    expectTypeOf<(typeof GOVERNANCE_OPERATION_KINDS)[number]>().toEqualTypeOf<
      (typeof STORED_KINDS)[number]
    >();
    expectTypeOf<typeof ConversationErasurePhase.Type>().toEqualTypeOf<
      (typeof STORED_PHASES)[number]
    >();
    expectTypeOf<keyof typeof ConversationErasureCounts.fields>().toEqualTypeOf<
      keyof typeof StoredCounts.fields
    >();

    expect(GOVERNANCE_OPERATION_KINDS).toEqual(STORED_KINDS);
    expect(ConversationErasurePhase.literals).toEqual(STORED_PHASES);
    expect(Object.keys(ConversationErasureCounts.fields)).toEqual(Object.keys(StoredCounts.fields));
  });
});
