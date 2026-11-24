import { describe, expect, test } from "bun:test";
import {
  appendProviderHandoffIntent,
  assertProviderWriteTarget,
  type ProviderHandoffIntent,
} from "./artifact-handoff-runtime.ts";

describe("artifact handoff targets", () => {
  test("accepts approval-gated writes and rejects execute, read, archived, and mismatched tools", () => {
    expect(() => assertProviderWriteTarget("sendgrid", "sendgrid.email.send")).not.toThrow();
    expect(() => assertProviderWriteTarget("shopify", "shopify.fulfillments.create")).not.toThrow();
    for (const [provider, toolName] of [
      ["snowflake", "snowflake.query.execute"],
      ["shopify", "shopify.products.search"],
      ["zendesk", "zendesk.tickets.create"],
      ["twilio", "sendgrid.email.send"],
    ] as const) {
      expect(() => assertProviderWriteTarget(provider, toolName)).toThrow(
        "active canonical provider write tool",
      );
    }
  });

  test("preserves live intents and rejects plans beyond live capacity", () => {
    const intent = (index: number): ProviderHandoffIntent => ({
      artifactId: `artifact-${index}` as never,
      createdAt: "2026-07-30T00:00:00.000Z",
      expiresAt: "2026-07-31T00:00:00.000Z",
      intentId: `intent-${index}` as never,
      provider: "sendgrid",
      providerInputHash: `hash-${index}`,
      toolName: "sendgrid.email.send",
    });
    const active = Array.from({ length: 20 }, (_, index) => intent(index));
    expect(() =>
      appendProviderHandoffIntent(active, intent(20), "2026-07-30T01:00:00.000Z"),
    ).toThrow("maximum of 20 active");

    const retained = appendProviderHandoffIntent(
      [...active.slice(0, 19), { ...intent(30), consumedAt: "2026-07-30T00:30:00.000Z" }],
      intent(20),
      "2026-07-30T01:00:00.000Z",
    );
    expect(retained).toHaveLength(20);
    expect(retained.map((candidate) => candidate.intentId)).toContain(active[0]!.intentId);
    expect(retained.map((candidate) => candidate.intentId)).toContain(intent(20).intentId);
  });
});
