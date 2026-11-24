import { describe, expect, test } from "bun:test";
import { AppLifecycleResponse } from "@deployments-ai/api-contract";
import { effectiveOrganizationCapabilities } from "@deployments-ai/db";
import { PLATFORM_CLI_SCOPES } from "@deployments-ai/identity";
import { Schema } from "effect";
import { operationAccess } from "../access.ts";
import { appWrites, grantDirectory, liveReleaseId } from "./app-state.ts";

const accessOf = (role: "admin" | "member") =>
  operationAccess({
    capabilities: effectiveOrganizationCapabilities(role, PLATFORM_CLI_SCOPES),
    organizationRole: role,
  });

describe("appWrites", () => {
  test("hides every write from a member and offers them all to an admin of an active app", () => {
    expect(appWrites("active", accessOf("member"))).toEqual({});
    expect(appWrites("active", accessOf("admin"))).toEqual({
      archiveApp: { enabled: true },
      attachAppDomain: { enabled: true },
      detachAppDomain: { enabled: true },
      eraseApp: { enabled: true },
      promoteAppRelease: { enabled: true },
      putAppGrant: { enabled: true },
      refreshAppDomain: { enabled: true },
      removeAppGrant: { enabled: true },
      setAppPublication: { enabled: true },
      updateApp: { enabled: true },
    });
  });

  test("an archived app refuses every write but delete and domain detach", () => {
    const refused = { enabled: false, reason: "Not available while the app is archived." };
    expect(appWrites("archived", accessOf("admin"))).toEqual({
      archiveApp: refused,
      attachAppDomain: refused,
      detachAppDomain: { enabled: true },
      eraseApp: { enabled: true },
      promoteAppRelease: refused,
      putAppGrant: refused,
      refreshAppDomain: refused,
      removeAppGrant: refused,
      setAppPublication: refused,
      updateApp: refused,
    });
  });

  test("a provisioning app takes settings, grants, and domains but no release or lifecycle change", () => {
    const refused = { enabled: false, reason: "Not available while the app is provisioning." };
    expect(appWrites("provisioning", accessOf("admin"))).toEqual({
      archiveApp: refused,
      attachAppDomain: { enabled: true },
      detachAppDomain: { enabled: true },
      eraseApp: refused,
      promoteAppRelease: refused,
      putAppGrant: { enabled: true },
      refreshAppDomain: { enabled: true },
      removeAppGrant: { enabled: true },
      setAppPublication: { enabled: true },
      updateApp: { enabled: true },
    });
  });

  test("an erasing app still lets an admin detach its domains", () => {
    const writes = appWrites("erasing", accessOf("admin"));
    expect(
      Object.entries(writes)
        .filter(([, state]) => state.enabled)
        .map(([write]) => write),
    ).toEqual(["detachAppDomain"]);
  });
});

test("an archived app keeps its live release; a draft and an erasing app have none", () => {
  const lifecycle = Schema.decodeUnknownSync(AppLifecycleResponse);
  expect(
    liveReleaseId(
      lifecycle({
        archivedAt: "2026-10-09T12:00:00.000Z",
        liveReleaseId: "01K000000000000000000000R1",
        state: "archived",
      }),
    ),
  ).toBe("01K000000000000000000000R1");
  expect(liveReleaseId(lifecycle({ liveReleaseId: null, state: "active" }))).toBeNull();
  expect(
    liveReleaseId(lifecycle({ requestedAt: "2026-10-09T12:00:00.000Z", state: "erasing" })),
  ).toBeNull();
});

test("grantDirectory names grants by member, flags inactive members, and offers ungranted members", () => {
  const ALICE = "01K000000000000000000000A1";
  const BOB = "01K000000000000000000000B2";
  const CAROL = "01K000000000000000000000C3";
  const GONE = "01K000000000000000000000D4";
  const updatedAt = "2026-10-09T12:30:00.000Z";
  expect(
    grantDirectory(
      [
        { principalId: GONE, role: "viewer", updatedAt },
        { principalId: CAROL, role: "viewer", updatedAt },
        { principalId: BOB, role: "editor", updatedAt },
      ],
      [
        { displayName: "Alice", principalId: ALICE, status: "active" },
        { displayName: "Bob", principalId: BOB, status: "active" },
        { primaryEmail: "carol@example.com", principalId: CAROL, status: "removed" },
        { displayName: "Dan", principalId: "01K000000000000000000000E5", status: "invited" },
      ],
    ),
  ).toEqual({
    candidates: [{ name: "Alice", principalId: ALICE }],
    grants: [
      { memberActive: true, name: "Bob", principalId: BOB, role: "editor", updatedAt },
      {
        memberActive: false,
        name: "carol@example.com",
        principalId: CAROL,
        role: "viewer",
        updatedAt,
      },
      {
        memberActive: false,
        name: "member …000000D4",
        principalId: GONE,
        role: "viewer",
        updatedAt,
      },
    ],
  });
});
