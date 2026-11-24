import { focusManager, onlineManager } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import { act } from "react";
import { PlatformApiError } from "../../errors.ts";
import { AppDomains } from "./app-domains.tsx";
import {
  active,
  answers,
  app,
  APP,
  AT,
  buttons,
  client,
  domain,
  render,
  rows,
  renderWith,
  scope,
  sent,
  typeInto,
  unverified,
  verified,
  withPolling,
  writesOf,
} from "./app-fixtures.tsx";

const shown = app({ audience: "members", serving: "single-page" });

const troubled = domain("01K000000000000000000000D4", "shop.example.com", {
  activatedAt: AT,
  kind: "active",
  problem: {
    code: "certificate_timed_out",
    message: "The certificate was not issued in time.",
    observedAt: AT,
  },
  verifiedAt: AT,
});

const refused = (status: number, code: string, retryAfterSeconds?: number) =>
  Promise.reject(
    new PlatformApiError("refreshAppDomain", {
      code,
      detail: code,
      status,
      title: "Request failed",
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    }),
  );

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));

describe("attach and detach", () => {
  test("attach sends the normalized hostname without a typed phrase, then opens its DNS records", async () => {
    answers.attachAppDomain = () =>
      Promise.resolve(
        domain("01K000000000000000000000D9", "shop.example.com", { kind: "unverified" }),
      );
    await renderWith(
      client({ domains: [], environment: "production" }),
      <AppDomains app={shown} scope={scope} writes={writesOf("admin")} />,
      async (view) => {
        const submit = () => buttons(view, "Attach domain").at(-1);
        await view.click(buttons(view, "Attach domain")[0]);
        const steps = [submit()?.hasAttribute("disabled")];
        await typeInto(view, "hostname", "  Shop.Example.COM ");
        steps.push(
          submit()?.hasAttribute("disabled"),
          view.document.querySelector('input[name="confirmation"]') !== null,
        );
        await view.click(submit());
        const dialog = view.document.querySelector("[role=dialog]");
        expect({
          dialog: dialog?.querySelector("h2")?.textContent,
          sent: sent.map(({ data, fn }) => [fn, data["body"]]),
          steps,
          txtName: dialog?.querySelector<HTMLInputElement>('input[aria-label="TXT name"]')?.value,
        }).toEqual({
          dialog: "DNS records for shop.example.com",
          sent: [["attachAppDomain", { hostname: "shop.example.com" }]],
          steps: [true, false, false],
          txtName: "_deployments-app.shop.example.com",
        });
      },
    );
  });

  test("detach sends the domain id once the hostname is typed, then focuses the Domains heading", async () => {
    answers.detachAppDomain = () => Promise.resolve(unverified);
    await render(
      <AppDomains app={shown} scope={scope} writes={writesOf("admin")} />,
      [unverified, active],
      async (view) => {
        const submit = () => buttons(view, "Detach domain")[0];
        await view.click(
          view.document.querySelector('button[aria-label="Detach www.example.com"]'),
        );
        const steps = [submit()?.hasAttribute("disabled")];
        await typeInto(view, "confirmation", "example.com");
        steps.push(submit()?.hasAttribute("disabled"));
        await typeInto(view, "confirmation", "www.example.com");
        steps.push(submit()?.hasAttribute("disabled"));
        await view.click(submit());
        const focused = view.document.activeElement;
        expect({
          focused: `${focused?.tagName} ${focused?.textContent}`,
          sent: sent.map(({ data, fn }) => [fn, data["appId"], data["domainId"]]),
          steps,
        }).toEqual({
          focused: "H2 Domains",
          sent: [["detachAppDomain", APP, "01K000000000000000000000D1"]],
          steps: [true, true, false],
        });
      },
    );
  });

  test("a cancelled detach returns focus to the row's Detach button", async () => {
    await render(
      <AppDomains app={shown} scope={scope} writes={writesOf("admin")} />,
      [unverified, active],
      async (view) => {
        const detach = view.document.querySelector<HTMLButtonElement>(
          'button[aria-label="Detach www.example.com"]',
        );
        await act(async () => detach?.focus());
        await view.click(detach);
        await view.click(buttons(view, "Cancel")[0]);
        const focused = view.document.activeElement;
        expect({
          dialog: view.document.querySelector("[role=dialog]"),
          focused: focused?.getAttribute("aria-label"),
          sent,
        }).toEqual({ dialog: null, focused: "Detach www.example.com", sent: [] });
      },
    );
  });

  test("row actions name the hostname they act on", async () => {
    await render(
      <AppDomains app={shown} scope={scope} writes={writesOf("admin")} />,
      [unverified, troubled],
      async (view) => {
        expect(
          [...view.document.querySelectorAll("tbody button")].map((button) =>
            button.getAttribute("aria-label"),
          ),
        ).toEqual([
          "DNS records for www.example.com",
          "Check now for www.example.com",
          "Detach www.example.com",
          "DNS records for shop.example.com",
          "Check now for shop.example.com",
          "Detach shop.example.com",
        ]);
      },
    );
  });

  test("the DNS records say the CNAME sends the hostname's traffic to the platform", async () => {
    await render(
      <AppDomains app={shown} scope={scope} writes={writesOf("member")} />,
      [unverified],
      async (view) => {
        await view.click(buttons(view, "DNS records")[0]);
        expect(view.document.querySelector("[role=dialog] p")?.textContent).toBe(
          "Publish both records at your DNS provider. The TXT record proves your organization controls the hostname, and the CNAME record sends traffic for the hostname to the platform. Publish the TXT record before the first check, because resolvers remember a miss for a while.",
        );
      },
    );
  });
});

describe("polling", () => {
  test("the list updates every 30 seconds while the platform works on a domain, or a member waits on one", async () => {
    const seen: Record<string, readonly [number[], number]> = {};
    await withPolling(async (polling) => {
      for (const [label, role, domains] of [
        ["member, unverified", "member", [unverified]],
        ["member, all active", "member", [active]],
        ["admin, unverified", "admin", [unverified]],
        ["admin, verified", "admin", [verified]],
        ["admin, active with a problem", "admin", [troubled]],
        ["admin, all active", "admin", [active]],
      ] as const) {
        await render(
          <AppDomains app={shown} scope={scope} writes={writesOf(role)} />,
          domains,
          async () => {
            seen[label] = [polling().map(({ delay }) => delay), sent.length];
          },
        );
      }
    });
    expect(seen).toEqual({
      "admin, active with a problem": [[30_000], 0],
      "admin, all active": [[], 0],
      "admin, unverified": [[], 0],
      "admin, verified": [[30_000], 0],
      "member, all active": [[], 0],
      "member, unverified": [[30_000], 0],
    });
  });

  test("Check now on an active domain with a certificate problem checks once, then the list follows it", async () => {
    answers.refreshAppDomain = () => Promise.resolve(troubled);
    await withPolling(async (polling) => {
      await render(
        <AppDomains app={shown} scope={scope} writes={writesOf("admin")} />,
        [troubled],
        async (view) => {
          await view.click(buttons(view, "Check now")[0]);
          expect({
            polling: polling().map(({ delay }) => delay),
            sent: sent.map(({ data, fn }) => [fn, data["domainId"]]),
          }).toEqual({
            polling: [30_000],
            sent: [["refreshAppDomain", "01K000000000000000000000D4"]],
          });
        },
      );
    });
  });

  const cases: readonly (readonly [string, readonly (() => Promise<unknown>)[], number[][]])[] = [
    ["403 stops", [() => refused(403, "forbidden")], [[]]],
    ["404 stops", [() => refused(404, "resource_not_found")], [[]]],
    ["409 domain_claimed stops", [() => refused(409, "domain_claimed")], [[]]],
    [
      "409 concurrent_modification keeps the cadence",
      [() => refused(409, "concurrent_modification")],
      [[30_000]],
    ],
    ["422 txt_not_found keeps the cadence", [() => refused(422, "txt_not_found")], [[30_000]]],
    [
      "429 backs off and doubles",
      [() => refused(429, "rate_limited"), () => refused(429, "rate_limited")],
      [[60_000], [120_000]],
    ],
    [
      "503 waits for Retry-After when it is longer",
      [() => refused(503, "dns_lookup_failed", 300)],
      [[300_000]],
    ],
    [
      "503 backs off, then a verification hands the domain to the list's 30-second update",
      [() => refused(503, "dns_lookup_failed", 5), () => Promise.resolve(verified)],
      [[60_000], [30_000]],
    ],
    [
      "a Retry-After past 10 minutes waits 10 minutes",
      [() => refused(503, "dns_lookup_failed", 3_000_000)],
      [[600_000]],
    ],
    [
      "four 422s, then a 503 backs off from the first step",
      [
        () => refused(422, "txt_not_found"),
        () => refused(422, "txt_not_found"),
        () => refused(422, "txt_not_found"),
        () => refused(422, "txt_not_found"),
        () => refused(503, "dns_lookup_failed"),
      ],
      [[30_000], [30_000], [30_000], [30_000], [60_000]],
    ],
    [
      "a 422 between two 503s backs off from the first step again",
      [
        () => refused(503, "dns_lookup_failed"),
        () => refused(422, "txt_not_found"),
        () => refused(503, "dns_lookup_failed"),
      ],
      [[60_000], [30_000], [60_000]],
    ],
  ];

  for (const [label, outcomes, expected] of cases) {
    test(`a publisher's unverified domain after Check now: ${label}, and stops on unmount`, async () => {
      let checks = 0;
      answers.refreshAppDomain = () => outcomes[checks++]?.() ?? Promise.reject(new Error("extra"));
      const delays: number[][] = [];
      let afterUnmount: number[] = [];
      await withPolling(async (polling) => {
        await render(
          <AppDomains app={shown} scope={scope} writes={writesOf("admin")} />,
          [unverified],
          async (view) => {
            for (const _ of outcomes) {
              if (delays.length === 0) await view.click(buttons(view, "Check now")[0]);
              else await act(async () => polling()[0]?.tick());
              await settle();
              delays.push(polling().map(({ delay }) => delay));
            }
          },
        );
        afterUnmount = polling().map(({ delay }) => delay);
      });
      expect({ afterUnmount, checks, delays }).toEqual({
        afterUnmount: [],
        checks: outcomes.length,
        delays: expected,
      });
    });
  }

  test("two failing domains each back off from their own count", async () => {
    const second = domain("01K000000000000000000000D5", "shop.example.com", { kind: "unverified" });
    answers.refreshAppDomain = (data) =>
      data["domainId"] === unverified.id &&
      sent.filter((call) => call.data["domainId"] === unverified.id).length === 2
        ? refused(422, "txt_not_found")
        : refused(503, "dns_lookup_failed");
    let delays: number[] = [];
    await withPolling(async (polling) => {
      await render(
        <AppDomains app={shown} scope={scope} writes={writesOf("admin")} />,
        [unverified, second],
        async (view) => {
          for (const hostname of [unverified.hostname, second.hostname]) {
            await view.click(
              view.document.querySelector(`button[aria-label="Check now for ${hostname}"]`),
            );
          }
          for (const timer of polling()) await act(async () => timer.tick());
          await settle();
          delays = polling().map(({ delay }) => delay);
        },
      );
    });
    expect(delays.toSorted((a, b) => a - b)).toEqual([30_000, 120_000]);
  });

  test("Check now during a scheduled check joins it, so each refusal counts once", async () => {
    const pending: PromiseWithResolvers<unknown>[] = [];
    answers.refreshAppDomain = () => {
      const next = Promise.withResolvers<unknown>();
      pending.push(next);
      return next.promise;
    };
    const busy = () =>
      new PlatformApiError("refreshAppDomain", {
        code: "dns_lookup_failed",
        status: 503,
        title: "Request failed",
      });
    const delays: number[][] = [];
    await withPolling(async (polling) => {
      await render(
        <AppDomains app={shown} scope={scope} writes={writesOf("admin")} />,
        [unverified],
        async (view) => {
          await view.click(buttons(view, "Check now")[0]);
          await act(async () => pending[0]?.reject(busy()));
          await settle();
          await act(async () => {
            polling()[0]?.tick();
            buttons(view, "Check now")[0]?.click();
          });
          await act(async () => pending[1]?.reject(busy()));
          await settle();
          delays.push(polling().map(({ delay }) => delay));
        },
      );
    });
    expect({ delays, requests: pending.length }).toEqual({ delays: [[120_000]], requests: 2 });
  });

  test("a check that verifies the domain ends the checks, however many intervals pass", async () => {
    answers.refreshAppDomain = () =>
      Promise.resolve(domain(unverified.id, unverified.hostname, verified.state));
    await withPolling(async (polling) => {
      await render(
        <AppDomains app={shown} scope={scope} writes={writesOf("admin")} />,
        [unverified],
        async (view) => {
          await view.click(buttons(view, "Check now")[0]);
          for (let interval = 0; interval < 3; interval += 1) {
            for (const timer of polling()) await act(async () => timer.tick());
            await settle();
          }
          expect({ refreshes: sent.length, state: rows(view)[0]?.state }).toEqual({
            refreshes: 1,
            state: "Verified",
          });
        },
      );
    });
  });

  test("a stopped check stays stopped when the window regains focus or the network returns", async () => {
    answers.refreshAppDomain = () => refused(409, "domain_claimed");
    const queryClient = client({ domains: [unverified] });
    queryClient.setDefaultOptions({ queries: { staleTime: 0 } });
    await withPolling(async () => {
      await renderWith(
        queryClient,
        <AppDomains app={shown} scope={scope} writes={writesOf("admin")} />,
        async (view) => {
          await view.click(buttons(view, "Check now")[0]);
          await act(async () => {
            focusManager.setFocused(false);
            focusManager.setFocused(true);
            onlineManager.setOnline(false);
            onlineManager.setOnline(true);
          });
          await settle();
          expect(sent.length).toBe(1);
        },
      );
    });
  });

  test("a stopped check stops saying it is checking", async () => {
    answers.refreshAppDomain = () => refused(404, "resource_not_found");
    await withPolling(async () => {
      await render(
        <AppDomains app={shown} scope={scope} writes={writesOf("admin")} />,
        [unverified],
        async (view) => {
          await view.click(buttons(view, "Check now")[0]);
          expect(
            view.document.querySelector("tbody")?.textContent?.includes("Checking every"),
          ).toBe(false);
        },
      );
    });
  });

  test("a backed-off check says how long it waits", async () => {
    answers.refreshAppDomain = () => refused(503, "dns_lookup_failed", 120);
    await withPolling(async () => {
      await render(
        <AppDomains app={shown} scope={scope} writes={writesOf("admin")} />,
        [unverified],
        async (view) => {
          await view.click(buttons(view, "Check now")[0]);
          expect(
            /Checking every \d+ seconds while this page is open\./u.exec(
              view.document.querySelector("tbody")?.textContent ?? "",
            )?.[0],
          ).toBe("Checking every 120 seconds while this page is open.");
        },
      );
    });
  });
});
