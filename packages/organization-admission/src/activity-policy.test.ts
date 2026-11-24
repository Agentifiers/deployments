import { haltMode, type HoldReason } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { decideActivity, type OrganizationActivity } from "./activity-policy.ts";
import { standingInstallation } from "./test-support.ts";

const ACTIVITIES = [
  "api.read",
  "api.write",
  "api.remediate",
  "api.erase",
  "api.distribute",
  "api.operate",
  "run.admit",
  "run.continue",
  "model.mint",
  "public.serve",
  "ingress.accept",
  "outbound.deliver",
  "background.process",
  "sandbox.lease",
] as const satisfies readonly OrganizationActivity[];

async function standingWith(reasons: readonly HoldReason[]) {
  const installation = standingInstallation();
  for (const reason of reasons) await installation.placeHold(reason);
  return installation.repository.read(installation.organizationId);
}

async function verdicts(reasons: readonly HoldReason[]) {
  const standing = await standingWith(reasons);
  return Object.fromEntries(
    ACTIVITIES.map((activity) => [activity, decideActivity(standing, activity).kind]),
  );
}

describe("what a suspended organization may do", () => {
  test("an active organization is admitted to everything", async () => {
    expect(await verdicts([])).toEqual({
      "api.distribute": "admitted",
      "api.erase": "admitted",
      "api.operate": "admitted",
      "api.read": "admitted",
      "api.remediate": "admitted",
      "api.write": "admitted",
      "background.process": "admitted",
      "ingress.accept": "admitted",
      "model.mint": "admitted",
      "outbound.deliver": "admitted",
      "public.serve": "admitted",
      "run.admit": "admitted",
      "run.continue": "admitted",
      "sandbox.lease": "admitted",
    });
  });

  test("a payment hold drains: admitted runs continue and nothing new starts", async () => {
    expect(await verdicts(["payment"])).toEqual({
      "api.distribute": "admitted",
      "api.erase": "admitted",
      "api.operate": "admitted",
      "api.read": "admitted",
      "api.remediate": "admitted",
      "api.write": "suspended",
      "background.process": "suspended",
      "ingress.accept": "suspended",
      "model.mint": "suspended",
      "outbound.deliver": "suspended",
      "public.serve": "suspended",
      "run.admit": "suspended",
      "run.continue": "admitted",
      "sandbox.lease": "suspended",
    });
  });

  test("an abuse hold stops running work and preserves evidence from erasure", async () => {
    expect(await verdicts(["abuse"])).toEqual({
      "api.distribute": "suspended",
      "api.erase": "suspended",
      "api.operate": "admitted",
      "api.read": "admitted",
      "api.remediate": "admitted",
      "api.write": "suspended",
      "background.process": "suspended",
      "ingress.accept": "suspended",
      "model.mint": "suspended",
      "outbound.deliver": "suspended",
      "public.serve": "suspended",
      "run.admit": "suspended",
      "run.continue": "suspended",
      "sandbox.lease": "suspended",
    });
  });

  test("a stopping hold beside a payment hold stops", async () => {
    const standing = await standingWith(["payment", "policy"]);

    expect(standing.state === "suspended" ? haltMode(standing.holds) : "active").toBe("stop");
    expect(decideActivity(standing, "run.continue").kind).toBe("suspended");
  });

  test("a refusal carries each hold so the caller can show why", async () => {
    const standing = await standingWith(["payment"]);

    const decision = decideActivity(standing, "api.write");

    expect(
      decision.kind === "suspended"
        ? decision.holds.map(({ customerMessage, placedAt, reason }) => ({
            customerMessage,
            placedAt,
            reason,
          }))
        : decision,
    ).toEqual([
      {
        customerMessage: "Update your payment method.",
        placedAt: "2026-10-01T00:00:00.000Z",
        reason: "payment",
      },
    ]);
  });
});
