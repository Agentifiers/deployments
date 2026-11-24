import { describe, expect, test } from "bun:test";
import {
  dataBoundaryOf,
  decideEgress,
  OrganizationDataBoundary,
  type EgressDestination,
  type EgressDestinations,
} from "@deployments-ai/db";
import { Schema } from "effect";
import {
  ALWAYS_UNKNOWN_EGRESS_TOOLS,
  findPlatformToolAdapterDefinition,
  hasPerCallEgressDecision,
  platformToolAdapterDefinitions,
  toolEgress,
  toolEgressDestinations,
  type ToolAdapterDefinition,
} from "./index.ts";

function definition(toolName: string): ToolAdapterDefinition {
  const found = findPlatformToolAdapterDefinition(toolName);
  if (!found) throw new Error(`${toolName} is not a platform tool.`);
  return found;
}

const destinationsOf = (toolName: string, input: Record<string, unknown>) =>
  toolEgressDestinations(definition(toolName), input);

const url = (value: string): EgressDestination => ({
  kind: "url",
  origin: new URL(value).origin,
  url: value,
});
const recipient = (address: string): EgressDestination => ({
  address,
  kind: "recipient",
});
const known = (...destinations: readonly EgressDestination[]): EgressDestinations => ({
  destinations,
  kind: "known",
});
const unknownResult: EgressDestinations = {
  kind: "unknown",
  reason: expect.any(String),
};

const phi = dataBoundaryOf(
  Schema.decodeUnknownSync(OrganizationDataBoundary)({
    operatorNote: "BAA-2026-17",
    profile: "phi",
    setAt: "2026-11-01T00:00:00.000Z",
    setBy: { kind: "operator", principalId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
  }),
);

describe("toolEgressDestinations", () => {
  test.each<[string, Record<string, unknown>, EgressDestinations]>([
    [
      "web.scrape",
      { formats: ["markdown"], url: "https://a.example/p?q=1" },
      known(url("https://a.example/p?q=1")),
    ],
    ["web.map", { search: "pricing", url: "https://a.example/" }, known(url("https://a.example/"))],
    [
      "web.crawl",
      { limit: 10, url: "https://a.example/docs" },
      known(url("https://a.example/docs")),
    ],
    [
      "web.batch_scrape",
      { urls: ["https://a.example/1", "https://b.example/2"] },
      known(url("https://a.example/1"), url("https://b.example/2")),
    ],
    [
      "web.search",
      {
        options: {
          excludeDomains: ["c.example"],
          includeDomains: ["a.example", "b.example"],
        },
        query: "flu clinic hours",
      },
      known({
        kind: "search-query",
        query: "flu clinic hours (site:a.example OR site:b.example) -site:c.example",
      }),
    ],
    [
      "web.search",
      { limit: 5, query: "flu clinic hours" },
      known({ kind: "search-query", query: "flu clinic hours" }),
    ],
    [
      "firecrawl.page.scrape",
      { formats: ["markdown"], url: "https://a.example/" },
      known(url("https://a.example/")),
    ],
    [
      "firecrawl.page.scrape",
      {
        body: { onlyMainContent: true, url: "https://b.example/" },
        url: "https://a.example/",
      },
      known(url("https://b.example/")),
    ],
    ["browser.capture_screenshot", { url: "https://a.example/" }, known(url("https://a.example/"))],
    ["browser.capture_screenshot", { url: "https://a.example" }, known(url("https://a.example"))],
    ["browser.session.plan", { url: "https://a.example/" }, known(url("https://a.example/"))],
    [
      "browser.screenshot.capture",
      { sessionPlanId: "x", url: "https://a.example/" },
      known(url("https://a.example/")),
    ],
    [
      "browser.dom_snapshot.capture",
      { sessionPlanId: "x", url: "https://a.example/" },
      known(url("https://a.example/")),
    ],
    [
      "browser.session.execute",
      {
        actions: [
          { selector: "#go", type: "click" },
          { type: "navigate", url: "https://b.example/next" },
          { milliseconds: 10, type: "wait" },
        ],
        sessionPlanId: "x",
        url: "https://a.example/",
      },
      known(url("https://a.example/"), url("https://b.example/next")),
    ],
    [
      "sendgrid.email.send",
      {
        body: {
          content: [{ type: "text/plain", value: "hi" }],
          from: { email: "clinic@sender.example" },
          personalizations: [
            {
              bcc: [{ email: "audit@c.example" }],
              cc: [{ email: "b@b.example", name: "B" }],
              to: [{ email: "a@a.example" }],
            },
            { to: [{ email: "d@d.example" }] },
          ],
          subject: "Visit",
        },
      },
      known(
        recipient("a@a.example"),
        recipient("b@b.example"),
        recipient("audit@c.example"),
        recipient("d@d.example"),
      ),
    ],
    [
      "sendgrid.email.send",
      {
        body: {
          mail_settings: {
            bcc: { email: "audit@c.example", enable: true },
            bypass_list_management: { enable: false },
            footer: { enable: true, text: "Thanks" },
            sandbox_mode: { enable: false },
          },
          personalizations: [{ to: [{ email: "a@a.example" }] }],
          tracking_settings: {
            click_tracking: { enable: false },
            ganalytics: { enable: true, utm_source: "clinic" },
            open_tracking: { enable: false },
            subscription_tracking: { enable: false },
          },
        },
      },
      known(recipient("a@a.example"), recipient("audit@c.example")),
    ],
    [
      "postmark.email.send",
      {
        body: {
          Bcc: "audit@c.example",
          Cc: '"Front Desk" <desk@b.example>',
          From: "clinic@sender.example",
          Subject: "Visit",
          TextBody: "hi",
          To: "a@a.example, Ann Lee <ann@a.example>",
        },
      },
      known(
        recipient("a@a.example"),
        recipient("ann@a.example"),
        recipient("desk@b.example"),
        recipient("audit@c.example"),
      ),
    ],
    [
      "demio.event.registration.create",
      {
        body: { email: "attendee@a.example", event_id: "e1", name: "Attendee" },
      },
      known(recipient("attendee@a.example")),
    ],
    [
      "twilio.messages.send",
      {
        accountSid: "AC1",
        body: "hi",
        from: "+15550000001",
        mediaUrls: ["https://media.example/x.png"],
        to: "+15550000002",
      },
      known(recipient("+15550000002"), url("https://media.example/x.png")),
    ],
    [
      "plivo.messages.send",
      {
        authId: "MA1",
        dst: "+15550000002",
        src: "+15550000001",
        text: "hi",
        url: "https://hooks.example/status",
      },
      known(recipient("+15550000002"), url("https://hooks.example/status")),
    ],
  ])("%s reads every destination from %j", (toolName, input, expected) => {
    expect(destinationsOf(toolName, input)).toEqual(expected);
  });

  test.each<[string, Record<string, unknown>]>([
    ["web.scrape", { url: "http://a.example/" }],
    ["web.scrape", { url: "https://user:pass@a.example/" }],
    ["web.scrape", { url: "not a url" }],
    ["web.scrape", {}],
    ["web.batch_scrape", { urls: ["https://a.example/", "http://b.example/"] }],
    ["web.batch_scrape", { urls: [] }],
    ["web.crawl", { url: "ftp://a.example/" }],
    ["web.crawl", { allowExternalLinks: true, url: "https://a.example/" }],
    ["web.crawl", { options: { allowSubdomains: true }, url: "https://a.example/" }],
    ["web.search", { query: "  " }],
    ["web.search", { options: { scrapeOptions: { formats: ["markdown"] } }, query: "q" }],
    ["web.search", { options: { includeDomains: "a.example" }, query: "q" }],
    ["firecrawl.page.scrape", { body: { url: "http://b.example/" }, url: "https://a.example/" }],
    [
      "firecrawl.page.scrape",
      { body: { webhook: "https://w.example/" }, url: "https://a.example/" },
    ],
    ["browser.capture_screenshot", { url: "http://127.0.0.1:3000/" }],
    [
      "browser.session.execute",
      {
        actions: [{ type: "navigate", url: "http://b.example/" }],
        url: "https://a.example/",
      },
    ],
    [
      "browser.session.execute",
      { actions: [{ url: "https://b.example/" }], url: "https://a.example/" },
    ],
    ["browser.session.execute", { url: "https://a.example/" }],
    ["sendgrid.email.send", { body: { personalizations: [{ to: [{ name: "No address" }] }] } }],
    [
      "sendgrid.email.send",
      {
        body: {
          personalizations: [{ headers: { Bcc: "x@x.example" }, to: [{ email: "a@a.example" }] }],
        },
      },
    ],
    ["sendgrid.email.send", { body: { personalizations: [] } }],
    [
      "sendgrid.email.send",
      {
        body: {
          mail_settings: { spam_check: { enable: true, post_to_url: "https://evil.example/" } },
          personalizations: [{ to: [{ email: "a@a.example" }] }],
        },
      },
    ],
    [
      "sendgrid.email.send",
      {
        body: {
          personalizations: [{ to: [{ email: "a@a.example" }] }],
          tracking_settings: { webhook: { url: "https://evil.example/" } },
        },
      },
    ],
    ["postmark.email.send", { body: { To: '"Lee, Ann" <ann@a.example>' } }],
    [
      "postmark.email.send",
      {
        body: {
          Headers: [{ Name: "Bcc", Value: "x@x.example" }],
          To: "a@a.example",
        },
      },
    ],
    ["demio.event.registration.create", { body: { email: "not-an-email", event_id: "e1" } }],
    [
      "twilio.messages.send",
      {
        from: "+15550000001",
        mediaUrls: ["http://media.example/x.png"],
        to: "+15550000002",
      },
    ],
    ["twilio.messages.send", { from: "+15550000001", to: "5550000002" }],
    [
      "plivo.messages.send",
      {
        dst: "+15550000002",
        src: "+15550000001",
        url: "https://u:p@hooks.example/",
      },
    ],
    // WHATWG reads the host as allowed.example; other parsers read evil.example.
    [
      "twilio.messages.send",
      {
        from: "+15550000001",
        mediaUrls: ["https://allowed.example\\@evil.example/x"],
        to: "+15550000002",
      },
    ],
    [
      "plivo.messages.send",
      {
        dst: "+15550000002",
        src: "+15550000001",
        url: "https://allowed.example\\@evil.example/x",
      },
    ],
    [
      "twilio.messages.send",
      {
        from: "+15550000001",
        mediaUrls: ["https://allowed.example/a\tb"],
        to: "+15550000002",
      },
    ],
    ["web.scrape", { url: "https://allowed.example/a b" }],
    ["web.scrape", { url: " https://allowed.example/" }],
  ])("%s with unreadable destinations %j is unknown", (toolName, input) => {
    expect(destinationsOf(toolName, input)).toEqual(unknownResult);
  });

  test.each<[string, Record<string, unknown>]>([
    ["web.scrape", { formats: ["json"], url: "https://a.example/" }],
    ["web.scrape", { formats: ["markdown", "summary"], url: "https://a.example/" }],
    [
      "web.scrape",
      {
        formats: [{ type: "changeTracking" }, "markdown"],
        url: "https://a.example/",
      },
    ],
    [
      "web.scrape",
      {
        formats: [{ prompt: "extract", type: "json" }],
        url: "https://a.example/",
      },
    ],
    [
      "web.scrape",
      {
        formats: [{ type: "question", question: "q?" }],
        url: "https://a.example/",
      },
    ],
    ["web.scrape", { formats: ["branding"], url: "https://a.example/" }],
    [
      "web.scrape",
      {
        options: { formats: [{ schema: {}, type: "json" }] },
        url: "https://a.example/",
      },
    ],
    ["web.scrape", { options: { jsonOptions: { prompt: "p" } }, url: "https://a.example/" }],
    ["web.scrape", { options: { onlyCleanContent: true }, url: "https://a.example/" }],
    ["web.batch_scrape", { options: { formats: ["summary"] }, urls: ["https://a.example/"] }],
    ["web.crawl", { options: { prompt: "only docs" }, url: "https://a.example/" }],
    ["web.crawl", { scrapeOptions: { formats: ["json"] }, url: "https://a.example/" }],
    [
      "web.crawl",
      {
        options: { scrapeOptions: { formats: ["summary"] } },
        url: "https://a.example/",
      },
    ],
    ["web.search", { options: { highlights: true }, query: "q" }],
    ["firecrawl.page.scrape", { formats: ["json"], url: "https://a.example/" }],
    [
      "firecrawl.page.scrape",
      { body: { formats: [{ type: "summary" }] }, url: "https://a.example/" },
    ],
    ["firecrawl.page.scrape", { body: { jsonOptions: { schema: {} } }, url: "https://a.example/" }],
  ])("%s with LLM-backed options %j is unknown", (toolName, input) => {
    expect(destinationsOf(toolName, input)).toEqual({
      kind: "unknown",
      reason: "This call uses the web tools LLM, which is not inside the boundary.",
    });
  });

  test("page-only formats keep the call known", () => {
    expect(
      destinationsOf("web.scrape", {
        formats: ["markdown", "html", "rawHtml", "links", "images", { type: "screenshot" }],
        url: "https://a.example/",
      }),
    ).toEqual(known(url("https://a.example/")));
  });

  test("interactive scrape actions make the call unknown", () => {
    expect(
      destinationsOf("firecrawl.page.scrape", {
        body: {
          actions: [{ script: "fetch('https://x.example')", type: "executeJavascript" }],
        },
        url: "https://a.example/",
      }),
    ).toEqual(unknownResult);
  });

  test("always-unknown public tools explain why they are denied", () => {
    for (const toolName of [
      "code.execute",
      "computer.action",
      "sandbox.files.read",
      "app.release",
      "artifact.share",
      "web.deep_research",
      "web.extract",
    ]) {
      expect(destinationsOf(toolName, { query: "q", url: "https://a.example/" })).toEqual({
        kind: "unknown",
        reason: ALWAYS_UNKNOWN_EGRESS_TOOLS[toolName]!,
      });
    }
  });

  test("an unregistered tool is unknown", () => {
    expect(
      toolEgressDestinations(
        {
          defaultPolicyAction: "allow",
          description: "Test tool.",
          effect: "read",
          execution: { type: "builtin" },
          toolName: "clinic.unregistered",
        },
        { url: "https://a.example/" },
      ),
    ).toEqual(unknownResult);
  });
});

describe("per-call egress registry", () => {
  const activePublic = platformToolAdapterDefinitions.filter(
    (tool) => tool.status === "active" && toolEgress(tool) === "public",
  );

  test("every active public platform tool has an extractor or an always-unknown reason", () => {
    expect(
      activePublic
        .filter(
          (tool) =>
            hasPerCallEgressDecision(tool) ===
            Object.hasOwn(ALWAYS_UNKNOWN_EGRESS_TOOLS, tool.toolName),
        )
        .map(({ toolName }) => toolName),
    ).toEqual([]);
  });

  test("every always-unknown entry names an active public platform tool", () => {
    const names = new Set(activePublic.map(({ toolName }) => toolName));
    expect(Object.keys(ALWAYS_UNKNOWN_EGRESS_TOOLS).filter((name) => !names.has(name))).toEqual([]);
  });

  test("pins the public tools that get per-call decisions", () => {
    expect(
      activePublic
        .filter(hasPerCallEgressDecision)
        .map(({ toolName }) => toolName)
        .sort(),
    ).toEqual([
      "browser.capture_screenshot",
      "browser.dom_snapshot.capture",
      "browser.screenshot.capture",
      "browser.session.execute",
      "browser.session.plan",
      "demio.event.registration.create",
      "firecrawl.page.scrape",
      "plivo.messages.send",
      "postmark.email.send",
      "sendgrid.email.send",
      "twilio.messages.send",
      "web.batch_scrape",
      "web.crawl",
      "web.map",
      "web.scrape",
      "web.search",
    ]);
  });

  test("hosted code with sandbox network access has no per-call decision", () => {
    const hostedCode = {
      defaultPolicyAction: "allow",
      description: "Hosted code that shares a tool name with an extractor.",
      effect: "read",
      execution: {
        contentHash: "sha256:test",
        entrypoint: "index.js",
        language: "javascript",
        memoryMiB: 256,
        network: "sandbox",
        secretNames: [],
        sourceLanguage: "javascript",
        timeoutMs: 1_000,
        type: "hosted_code",
      },
      toolName: "web.scrape",
    } satisfies ToolAdapterDefinition;

    expect(toolEgress(hostedCode)).toBe("public");
    expect(hasPerCallEgressDecision(hostedCode)).toBe(false);
    expect(toolEgressDestinations(hostedCode, { url: "https://a.example/" })).toEqual(
      unknownResult,
    );
  });

  test("a platform-egress tool has no per-call decision", () => {
    expect(hasPerCallEgressDecision(definition("web.crawl_status"))).toBe(false);
    expect(hasPerCallEgressDecision(definition("agent.memory.search"))).toBe(false);
  });
});

describe("decideEgress with extracted destinations", () => {
  const allowlist = [{ origin: "https://a.example" }];

  test("a call to an allowlisted origin is allowed", () => {
    expect(
      decideEgress(phi, allowlist, destinationsOf("web.scrape", { url: "https://a.example/x" })),
    ).toEqual({ action: "allow" });
  });

  test("a mixed call asks for approval of only the non-allowlisted destinations", () => {
    expect(
      decideEgress(
        phi,
        allowlist,
        destinationsOf("web.batch_scrape", {
          urls: ["https://a.example/1", "https://b.example/2"],
        }),
      ),
    ).toEqual({
      action: "require-approval",
      destinations: [url("https://b.example/2")],
    });
  });

  test("a recipient always needs approval, even with its URLs allowlisted", () => {
    expect(
      decideEgress(
        phi,
        allowlist,
        destinationsOf("twilio.messages.send", {
          from: "+15550000001",
          mediaUrls: ["https://a.example/x.png"],
          to: "+15550000002",
        }),
      ),
    ).toEqual({
      action: "require-approval",
      destinations: [recipient("+15550000002")],
    });
  });

  test("an unknown call is denied", () => {
    expect(
      decideEgress(
        phi,
        allowlist,
        destinationsOf("web.scrape", {
          formats: ["json"],
          url: "https://a.example/",
        }),
      ),
    ).toEqual({
      action: "deny",
      reason: "This call uses the web tools LLM, which is not inside the boundary.",
    });
    expect(decideEgress(phi, allowlist, destinationsOf("code.execute", {}))).toEqual({
      action: "deny",
      reason: ALWAYS_UNKNOWN_EGRESS_TOOLS["code.execute"]!,
    });
  });
});
