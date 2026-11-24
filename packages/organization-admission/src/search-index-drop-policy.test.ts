import { HoldKey, StandingActor, type HoldReason } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { decideSearchIndexDrop } from "./search-index-drop-policy.ts";
import { standingInstallation } from "./test-support.ts";

const BILLING = Schema.decodeUnknownSync(StandingActor)({ kind: "service", service: "billing" });

async function decision(holds: { readonly operator?: HoldReason; readonly service?: HoldReason }) {
  const installation = standingInstallation();
  if (holds.service) {
    await installation.repository.placeHold({
      actor: BILLING,
      customerMessage: "Update your payment method.",
      key: Schema.decodeUnknownSync(HoldKey)("billing-review"),
      organizationId: installation.organizationId,
      reason: holds.service,
    });
  }
  if (holds.operator) {
    installation.advance(60_000);
    await installation.placeHold(holds.operator);
  }
  const verdict = decideSearchIndexDrop(
    await installation.repository.read(installation.organizationId, { consistent: true }),
  );
  return verdict.kind === "authorized"
    ? { hold: `${verdict.hold.source}/${verdict.hold.key}`, kind: verdict.kind }
    : verdict;
}

describe("which organizations may have their search indexes dropped", () => {
  test("only an organization an operator suspended without preserving evidence", async () => {
    expect({
      active: await decision({}),
      evidence: await decision({ operator: "manual", service: "abuse" }),
      operatorManual: await decision({ operator: "manual" }),
      operatorPayment: await decision({ operator: "payment" }),
      operatorPaymentBesideServiceManual: await decision({
        operator: "payment",
        service: "manual",
      }),
      operatorPolicyBesideServicePayment: await decision({
        operator: "policy",
        service: "payment",
      }),
      serviceManual: await decision({ service: "manual" }),
    }).toEqual({
      active: { kind: "refused", reason: "organization-active" },
      evidence: { kind: "refused", reason: "evidence-preserved" },
      operatorManual: { hold: "operator/manual-review", kind: "authorized" },
      operatorPayment: { kind: "refused", reason: "organization-draining" },
      operatorPaymentBesideServiceManual: { kind: "refused", reason: "no-operator-hold" },
      operatorPolicyBesideServicePayment: { hold: "operator/policy-review", kind: "authorized" },
      serviceManual: { kind: "refused", reason: "no-operator-hold" },
    });
  });

  test("the earliest operator hold authorizes the drop", async () => {
    const installation = standingInstallation();
    await installation.placeHold("policy");
    installation.advance(60_000);
    await installation.placeHold("manual");

    const verdict = decideSearchIndexDrop(
      await installation.repository.read(installation.organizationId, { consistent: true }),
    );

    expect(
      verdict.kind === "authorized"
        ? [verdict.hold.key, verdict.hold.placedAt, verdict.hold.reason]
        : verdict,
    ).toEqual(["policy-review", "2026-10-01T00:00:00.000Z", "policy"]);
  });
});
