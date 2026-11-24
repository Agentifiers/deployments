import { describe, expect, test } from "bun:test";
import { renderIdentityEmail } from "./render.tsx";

describe("account lifecycle emails", () => {
  test("asks the new address to confirm with a fragment link and a UTC expiry", async () => {
    const actionUrl = "https://auth.deployments.ai/email-change/confirm#token=01ARZ.secret%2Bvalue";
    const rendered = await renderIdentityEmail({
      actionUrl,
      expiresAt: "2026-08-01T23:30:00.000Z",
      purpose: "email-change-verify",
    });

    expect(rendered.subject).toBe("Confirm your new Deployments.ai email address");
    expect(rendered.html).toContain(`href="${actionUrl}"`);
    expect(rendered.text).toContain(actionUrl);
    expect(rendered.text).toContain("Your email changes only after you open the link and confirm.");
    expect(rendered.text).toContain("expires August 1, 2026 at 11:30 PM UTC");
    expect(rendered.html.length).toBeLessThan(102_400);
  });

  test("tells the old address where the account moved and how to report it", async () => {
    const actionUrl = "https://auth.deployments.ai/email-change/report#token=01ARZ.secret";
    const rendered = await renderIdentityEmail({
      actionUrl,
      expiresAt: "2026-08-08T23:30:00.000Z",
      newEmail: "ada<script>@new.example",
      purpose: "email-changed",
    });

    expect(rendered.subject).toBe("Your Deployments.ai email address changed");
    expect(rendered.html).toContain(`href="${actionUrl}"`);
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.text).toContain(
      "signs in with ada<script>@new.example instead of this address",
    );
    expect(rendered.text).toContain("This wasn’t me");
    expect(rendered.text).toContain("until August 8, 2026 at 11:30 PM UTC");
    expect(rendered.html.length).toBeLessThan(102_400);
  });

  test("tells the reported-away address the change was reported, without any link", async () => {
    const rendered = await renderIdentityEmail({ purpose: "email-change-reported" });

    expect(rendered.subject).toBe("An email change on Deployments.ai was reported");
    expect(rendered.html).not.toContain("href=");
    expect(rendered.text).toContain("the password stopped working");
  });

  test("confirms a deletion without any link", async () => {
    const rendered = await renderIdentityEmail({ purpose: "account-deleted" });

    expect(rendered.subject).toBe("Your Deployments.ai account was deleted");
    expect(rendered.html).not.toContain("href=");
    expect(rendered.text).toContain("Your Deployments.ai account was deleted.");
    expect(rendered.text).toContain("contact support immediately");
  });
});
