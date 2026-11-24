import { afterEach, expect, test } from "bun:test";
import type { AppAudience, AppRecord } from "@deployments-ai/db";
import { APPROVAL_RULES } from "./app-approval-rules.ts";
import { appToolHarness, id } from "./app-runtime-tools.fixture.ts";

const LIVE_RELEASE = id("99");

let harness = appToolHarness();
afterEach(() => {
  harness.guest.remove();
  harness = appToolHarness();
});

function inState(app: AppRecord, live: boolean, audience: AppAudience): AppRecord {
  return {
    ...app,
    data: {
      ...app.data,
      lifecycle: { liveReleaseId: live ? LIVE_RELEASE : null, state: "active" },
      publication: { audience, serving: "single-page" },
    },
  };
}

const STATES = [
  ["draft members", false, "members"],
  ["draft public", false, "public"],
  ["live members", true, "members"],
  ["live public", true, "public"],
] as const;

test("every app write tool decides approval from the app's state and the call", async () => {
  const draft = (await harness.apps.getApp(await harness.createApp()))!;
  const decide = (
    toolName: "app.migrate" | "app.promote" | "app.set_publication",
    input: Readonly<Record<string, unknown>>,
  ) => {
    const rule = APPROVAL_RULES[toolName];
    if (rule === "never") throw new Error(`${toolName} has no approval rule.`);
    return Object.fromEntries(
      STATES.map(([name, live, audience]) => [
        name,
        rule(inState(draft, live, audience), { appId: draft.data.id, ...input }),
      ]),
    );
  };
  const live = "This call needs approval because app orders is live.";
  const audiencePublic = "This call needs approval because app orders has a public audience.";
  const livePublic =
    "This call needs approval because app orders is live and has a public audience.";
  const opensDraft =
    "This call needs approval because it opens app orders, which has no live release yet, to anyone on the internet.";
  const opensLive =
    "This call needs approval because it opens live app orders to anyone on the internet.";
  const serves = "This call needs approval because it changes how live app orders serves pages.";
  const promoteDraftPublic =
    "This call needs approval because app orders, which has no live release yet, has a public audience.";

  expect({
    "app.dev_token": APPROVAL_RULES["app.dev_token"],
    "app.migrate": decide("app.migrate", {}),
    "app.promote": decide("app.promote", { releaseId: id("98") }),
    "app.promote of the live release": decide("app.promote", { releaseId: LIVE_RELEASE }),
    "app.release": APPROVAL_RULES["app.release"],
    "app.set_publication members": decide("app.set_publication", { audience: "members" }),
    "app.set_publication members and static-site": decide("app.set_publication", {
      audience: "members",
      serving: "static-site",
    }),
    "app.set_publication public": decide("app.set_publication", { audience: "public" }),
    "app.set_publication public and static-site": decide("app.set_publication", {
      audience: "public",
      serving: "static-site",
    }),
    "app.set_publication single-page": decide("app.set_publication", { serving: "single-page" }),
    "app.set_publication static-site": decide("app.set_publication", { serving: "static-site" }),
    "app.set_publication unreadable": decide("app.set_publication", { audience: "everyone" }),
  }).toEqual({
    "app.dev_token": "never",
    "app.migrate": {
      "draft members": null,
      "draft public": audiencePublic,
      "live members": live,
      "live public": livePublic,
    },
    "app.promote": {
      "draft members": null,
      "draft public": promoteDraftPublic,
      "live members":
        "This call needs approval because app orders is live on release 01J00000000000000000000099.",
      "live public":
        "This call needs approval because app orders is live on release 01J00000000000000000000099 and has a public audience.",
    },
    "app.promote of the live release": {
      "draft members": null,
      "draft public": promoteDraftPublic,
      "live members": null,
      "live public": null,
    },
    "app.release": "never",
    "app.set_publication members": {
      "draft members": null,
      "draft public": null,
      "live members": null,
      "live public": null,
    },
    "app.set_publication members and static-site": {
      "draft members": null,
      "draft public": null,
      "live members": serves,
      "live public": serves,
    },
    "app.set_publication public": {
      "draft members": opensDraft,
      "draft public": null,
      "live members": opensLive,
      "live public": null,
    },
    "app.set_publication public and static-site": {
      "draft members": opensDraft,
      "draft public": null,
      "live members":
        "This call needs approval because it opens live app orders to anyone on the internet and changes how live app orders serves pages.",
      "live public": serves,
    },
    "app.set_publication single-page": {
      "draft members": null,
      "draft public": null,
      "live members": null,
      "live public": null,
    },
    "app.set_publication static-site": {
      "draft members": null,
      "draft public": null,
      "live members": serves,
      "live public": serves,
    },
    "app.set_publication unreadable": {
      "draft members": null,
      "draft public": null,
      "live members": null,
      "live public": null,
    },
  });
});
