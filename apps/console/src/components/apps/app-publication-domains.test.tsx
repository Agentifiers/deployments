import type { AppResponse } from "@deployments-ai/api-contract";
import { describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { PlatformApiError } from "../../errors.ts";
import { AppDialogs } from "./app-dialogs.tsx";
import { AppDomains } from "./app-domains.tsx";
import {
  active,
  answers,
  app,
  APP,
  AT,
  buttons,
  domain,
  render,
  rows,
  scope,
  sent,
  TOKEN,
  typeInto,
  unverified,
  verified,
  writesOf,
} from "./app-fixtures.tsx";
import { AppPublication } from "./app-sections.tsx";

describe("Domains section", () => {
  test("a member without the publish role reads states and records but cannot change or check", async () => {
    await render(
      <AppDomains
        app={app({ audience: "members", serving: "single-page" })}
        scope={scope}
        writes={writesOf("member")}
      />,
      [unverified, verified, active],
      async (view) => {
        expect(rows(view).map(({ hostname, state }) => [hostname, state])).toEqual([
          ["www.example.com", "Unverified"],
          ["events.example.com", "Verified"],
          ["example.com", "Active"],
        ]);
        expect(rows(view)[1]?.text).toContain(
          "The certificate authority could not validate the hostname.",
        );
        expect({
          attach: buttons(view, "Attach domain").length,
          check: buttons(view, "Check now").length,
          detach: buttons(view, "Detach").length,
          records: buttons(view, "DNS records").length,
          sent: sent.length,
        }).toEqual({ attach: 0, check: 0, detach: 0, records: 3, sent: 0 });
      },
    );
  });

  test("a publisher's verified domain is not checked on open, and Check now queues its setup once", async () => {
    answers.refreshAppDomain = () => Promise.resolve(verified);
    await render(
      <AppDomains
        app={app({ audience: "public", serving: "static-site" })}
        scope={scope}
        writes={writesOf("admin")}
      />,
      [unverified, verified],
      async (view) => {
        const statuses = () =>
          [...view.document.querySelectorAll("tbody tr")].map((row) =>
            [...(row.querySelectorAll("td")[1]?.querySelectorAll("p") ?? [])]
              .filter((paragraph) => !paragraph.classList.contains("text-destructive"))
              .map((paragraph) => paragraph.textContent),
          );
        const progress = {
          unverified:
            "Publish the DNS records, then check the domain to prove your organization controls it.",
          verified:
            "Ownership proven. The platform is issuing a certificate and connecting the hostname to the app.",
        };
        const step =
          "Check that the CNAME record matches the one under DNS records, then check the domain to request a new certificate.";
        const opened = { sent: sent.length, statuses: statuses() };
        await view.click(
          view.document.querySelector('button[aria-label="Check now for events.example.com"]'),
        );
        expect({
          checked: statuses(),
          opened,
          sent: sent.map(({ data, fn }) => [fn, data["domainId"]]),
        }).toEqual({
          checked: [
            [progress.unverified],
            [
              progress.verified,
              step,
              "Setup queued. It usually starts within seconds. Updating every 30 seconds while this page is open.",
            ],
          ],
          opened: {
            sent: 0,
            statuses: [
              [progress.unverified],
              [progress.verified, step, "Updating every 30 seconds while this page is open."],
            ],
          },
          sent: [["refreshAppDomain", "01K000000000000000000000D2"]],
        });
      },
    );
  });

  test("each domain problem says what to do, and offers Check now only when a check helps", async () => {
    const codes = [
      "certificate_failed",
      "certificate_timed_out",
      "domain_conflict",
      "edge_rejected",
      "organization_certificate_limit",
      "platform_certificate_limit",
      "previous_tenant_draining",
    ];
    const troubled = codes.map((code, index) =>
      domain(`01K${"0".repeat(21)}P${index}`, `${code.replaceAll("_", "-")}.example.com`, {
        activatedAt: AT,
        kind: "active",
        problem: { code, message: "Recorded.", observedAt: AT },
        verifiedAt: AT,
      }),
    );
    await render(
      <AppDomains
        app={app({ audience: "members", serving: "single-page" })}
        scope={scope}
        writes={writesOf("admin")}
      />,
      troubled,
      async (view) => {
        expect(
          [...view.document.querySelectorAll("tbody tr")].map((row) => [
            row.querySelectorAll("td")[1]?.querySelectorAll("p")[2]?.textContent,
            [...row.querySelectorAll("button")].map((button) => button.textContent),
          ]),
        ).toEqual([
          [
            "Check that the CNAME record matches the one under DNS records, then check the domain to request a new certificate.",
            ["DNS records", "Check now", "Detach"],
          ],
          [
            "Fix the CNAME record so it matches the one under DNS records, then check the domain to request a new certificate.",
            ["DNS records", "Check now", "Detach"],
          ],
          [
            "Remove the hostname from the other CloudFront resource that serves it. The platform tries again at the time the message gives.",
            ["DNS records", "Detach"],
          ],
          [
            "Fix the CNAME record so it matches the one under DNS records. The platform tries again at the time the message gives.",
            ["DNS records", "Detach"],
          ],
          [
            "Wait. The platform requests the certificate at the time the message gives.",
            ["DNS records", "Detach"],
          ],
          [
            "Wait. The platform requests the certificate at the time the message gives.",
            ["DNS records", "Detach"],
          ],
          [
            "Wait. The platform connects the hostname once the earlier attachment is gone, usually in minutes.",
            ["DNS records", "Detach"],
          ],
        ]);
      },
    );
  });

  test("an unverified domain waits for Check now, then reports the TXT miss and keeps checking", async () => {
    answers.refreshAppDomain = () =>
      Promise.reject(
        new PlatformApiError("refreshAppDomain", {
          code: "txt_not_found",
          detail: `No TXT record at _deployments-app.www.example.com is ${TOKEN}.`,
          status: 422,
          title: "Request failed",
        }),
      );
    await render(
      <AppDomains
        app={app({ audience: "members", serving: "single-page" })}
        scope={scope}
        writes={writesOf("admin")}
      />,
      [unverified],
      async (view) => {
        const before = sent.length;
        await view.click(buttons(view, "Check now")[0]);
        expect({ before, after: sent.map(({ fn }) => fn), row: rows(view)[0]?.text }).toEqual({
          after: ["refreshAppDomain"],
          before: 0,
          row: `UnverifiedPublish the DNS records, then check the domain to prove your organization controls it.TXT record not found. No TXT record at _deployments-app.www.example.com is ${TOKEN}.Checking every 30 seconds while this page is open.`,
        });
      },
    );
  });

  test("an archived app's domains can be detached but not checked or attached", async () => {
    await render(
      <AppDomains
        app={app(
          { audience: "members", serving: "single-page" },
          { archivedAt: AT, liveReleaseId: null, state: "archived" },
        )}
        scope={scope}
        writes={writesOf("admin", "archived")}
      />,
      [verified],
      async (view) => {
        expect({
          attachDisabled: buttons(view, "Attach domain")[0]?.hasAttribute("disabled"),
          check: buttons(view, "Check now").length,
          detach: buttons(view, "Detach").length,
          refusal: view.document.body.textContent?.includes(
            "Not available while the app is archived.",
          ),
          sent: sent.length,
        }).toEqual({ attachDisabled: true, check: 0, detach: 1, refusal: true, sent: 0 });
      },
    );
  });

  test("DNS records list the TXT proof and the CNAME with the apex note", async () => {
    await render(
      <AppDomains
        app={app({ audience: "members", serving: "single-page" })}
        scope={scope}
        writes={writesOf("member")}
      />,
      [unverified],
      async (view) => {
        await view.click(buttons(view, "DNS records")[0]);
        const value = (label: string) =>
          view.document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)?.value;
        expect({
          apexNote: view.document
            .querySelector("[role=dialog]")
            ?.textContent?.includes("A zone apex cannot hold a CNAME"),
          cnameName: value("CNAME name"),
          cnameValue: value("CNAME value"),
          txtName: value("TXT name"),
          txtValue: value("TXT value"),
        }).toEqual({
          apexNote: true,
          cnameName: "www.example.com",
          cnameValue: "routing.apps.example.test",
          txtName: "_deployments-app.www.example.com",
          txtValue: TOKEN,
        });
      },
    );
  });
});

describe("Publication section", () => {
  test("shows the settings in plain words, and Change only to the publish role", async () => {
    const draft = app({ audience: "public", serving: "static-site" });
    const seen: unknown[] = [];
    for (const role of ["member", "admin"] as const) {
      await render(
        <AppPublication app={draft} onDialog={() => {}} writes={writesOf(role)} />,
        [],
        async (view) => {
          const text = view.document.body.textContent ?? "";
          seen.push({
            change: buttons(view, "Change").length,
            explainsPublic: text.includes(
              "Anyone on the internet can load the app's pages and call its visitor functions",
            ),
            explainsStaticSite: text.includes("Each page path returns its own HTML file"),
            notice: text.includes("Visitors reach the app once it has a live release."),
            role,
          });
        },
      );
    }
    expect(seen).toEqual([
      { change: 0, explainsPublic: true, explainsStaticSite: true, notice: true, role: "member" },
      { change: 1, explainsPublic: true, explainsStaticSite: true, notice: true, role: "admin" },
    ]);
  });

  test("going public asks for the typed slug; a serving change sends only serving under the dialog's key", async () => {
    let closed = 0;
    answers.setAppPublication = () =>
      Promise.resolve(app({ audience: "members", serving: "static-site" }));
    await render(
      <AppDialogs
        app={app({ audience: "members", serving: "single-page" })}
        dialog={{ kind: "publication" }}
        onClose={() => closed++}
        scope={scope}
      />,
      [],
      async (view) => {
        const radios = () => view.document.querySelectorAll("[role=radio]");
        const state = () => ({
          confirmation: view.document.querySelector('input[name="confirmation"]') !== null,
          saveDisabled: buttons(view, "Save publication")[0]?.hasAttribute("disabled"),
        });
        const steps = [state()];
        await view.click(radios()[1]);
        steps.push(state());
        await view.click(radios()[0]);
        await view.click(radios()[3]);
        steps.push(state());
        await view.click(buttons(view, "Save publication")[0]);
        expect({ closed, sent, steps }).toEqual({
          closed: 1,
          sent: [
            {
              data: {
                appId: APP,
                body: { serving: "static-site" },
                idempotencyKey: expect.any(String),
                scope,
              },
              fn: "setAppPublication",
            },
          ],
          steps: [
            { confirmation: false, saveDisabled: true },
            { confirmation: true, saveDisabled: true },
            { confirmation: false, saveDisabled: false },
          ],
        });
      },
    );
  });

  test("a failed database step locks the dialog and says that submitting again finishes it", async () => {
    answers.setAppPublication = () =>
      Promise.reject(
        new PlatformApiError("setAppPublication", {
          code: "internal_error",
          detail: "The app request failed.",
          status: 500,
          title: "Request failed",
        }),
      );
    await render(
      <AppDialogs
        app={app({ audience: "members", serving: "single-page" })}
        dialog={{ kind: "publication" }}
        onClose={() => {}}
        scope={scope}
      />,
      [],
      async (view) => {
        await view.click(view.document.querySelectorAll("[role=radio]")[3]);
        await view.click(buttons(view, "Save publication")[0]);
        await view.click(buttons(view, "Save publication")[0]);
        const alert = view.document.querySelector("[role=alert]")?.textContent ?? "";
        expect({
          keys: new Set(sent.map(({ data }) => data["idempotencyKey"])).size,
          leave: buttons(view, "Leave unfinished").length,
          message: alert.includes("Publication not changed yetThe app request failed."),
          notice: alert.includes("Submit again to finish under the same request."),
          sent: sent.map(({ data }) => data["body"]),
        }).toEqual({
          keys: 1,
          leave: 1,
          message: true,
          notice: true,
          sent: [{ serving: "static-site" }, { serving: "static-site" }],
        });
      },
    );
  });

  test("a locked retry resends the held body under the same key after the page's app changes", async () => {
    answers.setAppPublication = () =>
      Promise.reject(
        new PlatformApiError("setAppPublication", { status: 500, title: "Request failed" }),
      );
    let replace: (next: AppResponse) => void = () => {};
    function Page() {
      const [shown, setShown] = useState(app({ audience: "members", serving: "single-page" }));
      replace = setShown;
      return (
        <AppDialogs app={shown} dialog={{ kind: "publication" }} onClose={() => {}} scope={scope} />
      );
    }
    await render(<Page />, [], async (view) => {
      await view.click(view.document.querySelectorAll("[role=radio]")[1]);
      await typeInto(view, "confirmation", "sign-up");
      await view.click(buttons(view, "Save publication")[0]);
      await act(async () => replace(app({ audience: "members", serving: "static-site" })));
      await view.click(buttons(view, "Save publication")[0]);
    });
    const [first, second] = sent.map(({ data }) => data);
    expect({
      bodies: [first?.["body"], second?.["body"]],
      sameKey: first?.["idempotencyKey"] === second?.["idempotencyKey"],
    }).toEqual({
      bodies: [{ audience: "public" }, { audience: "public" }],
      sameKey: true,
    });
  });
});
