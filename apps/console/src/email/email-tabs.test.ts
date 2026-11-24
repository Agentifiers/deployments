import { effectiveOrganizationCapabilities } from "@deployments-ai/db";
import { PLATFORM_CLI_SCOPES } from "@deployments-ai/identity";
import { describe, expect, test } from "bun:test";
import { operationAccess } from "../access.ts";
import { emailTabs } from "./email-tabs.ts";

const access = operationAccess({
  capabilities: effectiveOrganizationCapabilities("owner", PLATFORM_CLI_SCOPES),
  organizationRole: "owner",
});
const labels = (managesSending: boolean) =>
  emailTabs("/e/email", "/e/email", access, managesSending).map((tab) => tab.label);

describe("emailTabs", () => {
  test("hides placements and sending tenants where the service provides sending", () => {
    expect(labels(false)).toEqual(["Inboxes", "Domains", "Policy", "Suppressions", "Usage"]);
  });

  test("lists them for an install that runs its own sending", () => {
    expect(labels(true)).toEqual([
      "Inboxes",
      "Domains",
      "Placements",
      "Policy",
      "Suppressions",
      "Usage",
      "Sending tenants",
    ]);
  });
});
