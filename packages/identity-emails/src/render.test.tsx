import { describe, expect, test } from "bun:test";
import { renderIdentityEmail } from "./render.tsx";

describe("identity email templates", () => {
  test("renders verification as accessible HTML and plain text with a fragment action", async () => {
    const actionUrl = "https://auth.deployments.ai/verify#verify=secret-action";
    const rendered = await renderIdentityEmail({
      actionUrl,
      purpose: "verify-email",
    });

    expect(rendered.subject).toBe("Verify your Deployments.ai email");
    expect(rendered.html).toContain("Verify your email");
    expect(rendered.html).toContain("https://auth.deployments.ai/verify#verify=secret-action");
    expect(rendered.text).toContain(actionUrl);
    expect(rendered.html.length).toBeLessThan(102_400);
  });

  test("renders every template with HTML and plain-text bodies", async () => {
    for (const input of [
      {
        actionUrl: "https://auth.deployments.ai/reset-password#reset=secret-action",
        purpose: "reset-password",
      },
      { purpose: "password-changed" },
      { purpose: "mfa-enabled" },
      { purpose: "mfa-disabled" },
      { purpose: "suspicious-refresh-reuse" },
    ] as const) {
      const rendered = await renderIdentityEmail(input);
      expect(rendered.html).toContain("DEPLOYMENTS.AI");
      expect(rendered.text.length).toBeGreaterThan(40);
      expect(rendered.html.length).toBeLessThan(102_400);
    }
  });

  test("renders an organization invitation with its link, names, role, and UTC expiry", async () => {
    const actionUrl =
      "https://app.deployments.ai/invitations/accept?invitation=01ARZ3NDEKTSV4RRFFQ69G5FAV&token=dpl_inv_secret";
    const rendered = await renderIdentityEmail({
      actionUrl,
      expiresAt: "2026-08-01T23:30:00.000Z",
      inviterName: "Ada <Lovelace>",
      organizationName: "Acme & Co",
      purpose: "organization-invitation",
      role: "admin",
    });

    expect(rendered.subject).toBe("Ada <Lovelace> invited you to Acme & Co on Deployments.ai");
    expect(rendered.html).toContain(`href="${actionUrl.replace("&", "&amp;")}"`);
    expect(rendered.text).toContain(actionUrl);
    expect(rendered.html).toContain("Ada &lt;Lovelace&gt;");
    expect(rendered.html).not.toContain("<Lovelace>");
    expect(rendered.text).toContain("Ada <Lovelace> invited you to join Acme & Co");
    expect(rendered.text).toContain("as admin");
    expect(rendered.text).toContain("August 1, 2026 at 11:30 PM UTC");
    expect(rendered.html.length).toBeLessThan(102_400);
  });

  test("renders a federated sign-in confirmation naming the organization and the IdP's host", async () => {
    const actionUrl =
      "https://auth.deployments.ai/federation/confirm-link#token=dpl_fed%2Bsecret%2Fvalue";
    const rendered = await renderIdentityEmail({
      actionUrl,
      expiresAt: "2026-08-01T23:30:00.000Z",
      identityProvider: { displayName: "Acme <Okta>", issuer: "https://acme.okta.com/oauth2" },
      organizationName: "Acme & Co",
      purpose: "federated-identity-link",
    });

    expect(rendered.subject).toBe("Confirm your Acme & Co sign-in connection on Deployments.ai");
    expect(rendered.html).toContain(`href="${actionUrl}"`);
    expect(rendered.html).not.toContain("<Okta>");
    expect(rendered.text).toContain(actionUrl);
    expect(rendered.text).toContain(
      "Someone signed in through Acme <Okta> (acme.okta.com), the identity provider for Acme & Co, using your email address.",
    );
    expect(rendered.text).toContain("This single-use link expires August 1, 2026 at 11:30 PM UTC.");
    expect(rendered.html.length).toBeLessThan(102_400);
  });

  test("names a SAML identity provider by its whole entity ID when it is not a URL", async () => {
    const rendered = await renderIdentityEmail({
      actionUrl: "https://auth.deployments.ai/federation/confirm-link#token=secret",
      expiresAt: "2026-08-01T23:30:00.000Z",
      identityProvider: { displayName: "Acme SAML", issuer: "urn:acme:idp" },
      organizationName: "Acme",
      purpose: "federated-identity-link",
    });
    expect(rendered.text).toContain(
      "Someone signed in through Acme SAML (urn:acme:idp), the identity provider for Acme, using your email address.",
    );
  });
});
