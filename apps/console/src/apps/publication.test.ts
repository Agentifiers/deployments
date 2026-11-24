import { expect, test } from "bun:test";
import { AppLifecycleResponse } from "@deployments-ai/api-contract";
import { Schema } from "effect";
import { publicationNotice } from "./publication.ts";

const RELEASE = "01K000000000000000000000R1";
const AT = "2026-10-09T12:00:00.000Z";

test("a public app explains why visitors cannot reach it until it is active and live", () => {
  const notice = (audience: "members" | "public", lifecycle: unknown) =>
    publicationNotice({
      lifecycle: Schema.decodeUnknownSync(AppLifecycleResponse)(lifecycle),
      publication: { audience, serving: "static-site" },
    }) ?? null;
  expect([
    notice("members", { liveReleaseId: null, state: "active" }),
    notice("public", { liveReleaseId: RELEASE, state: "active" }),
    notice("public", { liveReleaseId: null, state: "active" }),
    notice("public", { archivedAt: AT, liveReleaseId: RELEASE, state: "archived" }),
    notice("public", { requestedAt: AT, state: "provisioning" }),
  ]).toEqual([
    null,
    null,
    "Visitors reach the app once it has a live release.",
    "Visitors cannot open the app while it is archived. Only an active app with a live release is public.",
    "Visitors cannot open the app while it is provisioning. Only an active app with a live release is public.",
  ]);
});
