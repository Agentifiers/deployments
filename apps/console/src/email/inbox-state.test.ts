import { describe, expect, test } from "bun:test";
import { inboxTabs, parseInboxSearch, readBindingDraft, readInboxDraft } from "./inbox-state.ts";

describe("inbox state", () => {
  test("parses the status filter", () => {
    expect(parseInboxSearch({ status: "paused" })).toEqual({ status: "paused" });
    expect(parseInboxSearch({ status: "deleted" })).toEqual({});
  });

  test("inbox tabs mark the overview current only on the inbox page itself", () => {
    const base = "/e/1/email/inboxes/2";
    expect(inboxTabs(base, base)).toEqual([
      { current: true, href: base, label: "Overview" },
      { current: false, href: `${base}/threads`, label: "Threads" },
      { current: false, href: `${base}/messages`, label: "Messages" },
      { current: false, href: `${base}/drafts`, label: "Drafts" },
    ]);
    expect(
      inboxTabs(base, `${base}/threads/3`).map(({ current, label }) => [label, current]),
    ).toEqual([
      ["Overview", false],
      ["Threads", true],
      ["Messages", false],
      ["Drafts", false],
    ]);
  });

  test("the create-inbox body omits blank fields and lowercases the local part", () => {
    expect(readInboxDraft({ domainId: "", localPart: " Support ", name: "" })).toEqual({
      body: { localPart: "support" },
      ok: true,
    });
    expect(readInboxDraft({ domainId: "", localPart: "a b", name: "" }).ok).toBe(false);
  });

  test("a binding needs a deployment or an external ID", () => {
    expect(readBindingDraft({ agentDeploymentId: "", bindingType: "platform_agent" })).toBe(
      undefined,
    );
    expect(readBindingDraft({ bindingType: "external", externalId: " crm-7 " })).toEqual({
      bindingType: "external",
      externalId: "crm-7",
    });
  });
});
