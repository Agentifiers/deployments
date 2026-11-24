import { describe, expect, test } from "bun:test";
import {
  ORGANIZATION_CREATION_QUOTA_ENV,
  organizationCreationFromEnvironment,
} from "./organization-creation-config.ts";

describe("organization creation policy from the environment", () => {
  test("requires a verified email only where the API trusts platform identity", () => {
    expect([
      organizationCreationFromEnvironment({ [ORGANIZATION_CREATION_QUOTA_ENV]: "3" }, "platform"),
      organizationCreationFromEnvironment({}, "cognito"),
      organizationCreationFromEnvironment({}, undefined),
    ]).toEqual([
      { quotaPerPrincipal: 3, requireVerifiedEmail: true },
      { quotaPerPrincipal: null, requireVerifiedEmail: false },
      { quotaPerPrincipal: null, requireVerifiedEmail: false },
    ]);
  });

  test.each(["-1", "1.5", "three"])("rejects a quota of %s at cold start", (quota) => {
    expect(() =>
      organizationCreationFromEnvironment({ [ORGANIZATION_CREATION_QUOTA_ENV]: quota }, "platform"),
    ).toThrow(`${ORGANIZATION_CREATION_QUOTA_ENV} must be a whole number of organizations`);
  });
});
