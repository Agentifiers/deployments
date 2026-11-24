import { describe, expect, test } from "bun:test";
import { renderAlertEmail } from "./render.tsx";

const base = {
  actionUrl: "https://console.example.com/o/org/alerts/incidents/inc?monitor=m&x=1",
  monitorName: "Checkout <agent> failing",
  openedAt: "2026-11-02T10:15:00.000Z",
  preferencesUrl: "https://console.example.com/o/org/alerts/settings",
  productName: "Acme Agents",
  scopeLabel: "Production environment",
  summary: "5 failed runs in the last 15 minutes (threshold 3).",
} as const;

describe("alert email", () => {
  test("renders a firing alert with the summary, the links, and the install's name", async () => {
    const rendered = await renderAlertEmail({ ...base, status: "fired" });

    expect(rendered.subject).toBe("[Firing] Checkout <agent> failing");
    expect(rendered.html).toContain("ACME AGENTS");
    expect(rendered.html).not.toContain("DEPLOYMENTS.AI");
    expect(rendered.html).toContain("Checkout &lt;agent&gt; failing");
    expect(rendered.html).not.toContain("<agent>");
    expect(rendered.html).toContain(`href="${base.actionUrl.replaceAll("&", "&amp;")}"`);
    expect(rendered.html).toContain(`href="${base.preferencesUrl}"`);
    expect(rendered.text).toContain("Alert firing");
    expect(rendered.text).toContain(base.summary);
    expect(rendered.text).toContain("Opened November 2, 2026 at 10:15 AM UTC");
    expect(rendered.text).toContain("Change your alert emails");
    expect(rendered.html.length).toBeLessThan(102_400);
  });

  test("names every state in the subject and headline", async () => {
    for (const [status, subject, headline] of [
      ["renotified", "[Still firing]", "Alert still firing"],
      ["resolved", "[Resolved]", "Alert resolved"],
      ["test", "[Test]", "Test alert"],
    ] as const) {
      const rendered = await renderAlertEmail({ ...base, status });
      expect(rendered.subject.startsWith(subject)).toBe(true);
      expect(rendered.text).toContain(headline);
    }
  });
});
