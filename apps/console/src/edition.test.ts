import { describe, expect, test } from "bun:test";
import { INSTALL_COPY, type InstallCopy } from "./edition.ts";

/** Every customer-facing string in an edition's copy, with functions called on a sample. */
function strings(copy: InstallCopy): string[] {
  return Object.values(copy).flatMap((value): string[] => {
    if (typeof value === "string") return [value];
    if (typeof value === "function") return [value("Sample")];
    if (typeof value === "object") return Object.values(value);
    return [];
  });
}

describe("install copy", () => {
  test("the managed edition never sends customers to an operator, the install, or its settings", () => {
    for (const text of strings(INSTALL_COPY.managed)) {
      expect(text).not.toMatch(
        /operator|installation|\binstall\b|OpenTofu|PLATFORM_|_json|_enabled|platform deployment/iu,
      );
    }
  });

  test("the managed edition names the product or support wherever a customer cannot fix it", () => {
    const managed = INSTALL_COPY.managed;
    for (const text of [
      managed.agentEmailNotInstalled,
      managed.brainSearchUnavailable,
      managed.oauthProviderUnconfigured,
      managed.oauthReturnUnavailable,
      managed.searchNotEnabled,
      managed.memorySearchNeeded("Saving a policy"),
    ]) {
      expect(text).toMatch(/support|Deployments\.ai/u);
    }
    expect(managed.providerKeysNotAccepted("OpenRouter")).toBe(
      "Deployments.ai does not accept OpenRouter keys yet.",
    );
    expect(managed.systemAccessDenied).toContain("Deployments.ai staff");
  });

  test("the self-hosted edition keeps its operator guidance", () => {
    const selfHosted = INSTALL_COPY["self-hosted"];
    expect(selfHosted.providerKeysNotAccepted("OpenRouter")).toBe(
      "This installation does not accept OpenRouter keys.",
    );
    expect(selfHosted.oauthReturnUnavailable).toContain("PLATFORM_OAUTH_RETURN_ORIGINS");
    expect(selfHosted.erasureBillingNote).toBeUndefined();
    expect(selfHosted.offersBillingRole).toBe(false);
    expect(selfHosted.managesEmailSending).toBe(true);
  });

  test("the erasure note does not assume a Free organization has a subscription", () => {
    expect(INSTALL_COPY.managed.erasureBillingNote).toBe(
      "If the organization has a paid subscription, cancel it on the Billing page first.",
    );
  });
});
