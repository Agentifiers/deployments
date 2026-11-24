import { describe, expect, test } from "bun:test";
import { parseSystemServicePrincipals, resolveSystemService } from "./service-principals.ts";

function parse(principals: unknown) {
  return parseSystemServicePrincipals({
    DEPLOYMENTS_AI_AWS_ACCOUNT_ID: "123456789012",
    DEPLOYMENTS_AI_SYSTEM_SERVICE_PRINCIPALS: JSON.stringify(principals),
  });
}

const billing = {
  grants: ["organization-read", "organization-entitlements"],
  role_arn: "arn:aws:iam::123456789012:role/hosted/billing-service",
};

describe("system service principals", () => {
  test("maps an assumed-role session to the service that owns the role", () => {
    const parsed = parse({
      billing,
      "abuse-desk": { grants: [], role_arn: "arn:aws:iam::123456789012:role/abuse" },
    });
    if (parsed.kind !== "configured") throw new Error(parsed.error);

    const resolved = resolveSystemService(
      parsed.principals,
      "arn:aws:sts::123456789012:assumed-role/billing-service/reconciler",
    );
    expect<unknown>(resolved && { ...resolved, grants: [...resolved.grants] }).toEqual({
      grants: ["organization-read", "organization-entitlements"],
      name: "billing",
      role: { account: "123456789012", name: "billing-service", partition: "aws" },
    });
    expect(
      resolveSystemService(
        parsed.principals,
        "arn:aws:sts::210987654321:assumed-role/billing-service/reconciler",
      ),
    ).toBeUndefined();
  });

  test("configures no services when the install sets none", () => {
    expect(parseSystemServicePrincipals({})).toEqual({ kind: "configured", principals: [] });
  });

  test.each([
    [
      "a role in another account",
      { billing: { ...billing, role_arn: "arn:aws:iam::210987654321:role/billing-service" } },
      "billing: role_arn must be an IAM role ARN in this install's account.",
    ],
    [
      "two holders of organization-entitlements",
      {
        billing,
        reseller: {
          grants: ["organization-entitlements"],
          role_arn: "arn:aws:iam::123456789012:role/reseller",
        },
      },
      "At most one service may hold organization-entitlements.",
    ],
    [
      "two services sharing a role",
      {
        billing,
        mirror: { grants: [], role_arn: "arn:aws:iam::123456789012:role/other/billing-service" },
      },
      "mirror: another service already uses its role.",
    ],
  ])("refuses %s", (_label, principals, reason) => {
    expect(parse(principals)).toEqual({
      error: `DEPLOYMENTS_AI_SYSTEM_SERVICE_PRINCIPALS is invalid: ${reason}`,
      kind: "invalid",
    });
  });

  test.each([
    ["an unknown grant", { billing: { ...billing, grants: ["organization-delete"] } }],
    ["a name that is not a slug", { Billing: billing }],
  ])("refuses %s", (_label, principals) => {
    expect(parse(principals).kind).toBe("invalid");
    expect(parse({ billing }).kind).toBe("configured");
  });
});
