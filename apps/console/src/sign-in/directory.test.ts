import { describe, expect, test } from "bun:test";
import { DirectoryResponse } from "@deployments-ai/api-contract";
import { Schema } from "effect";
import { defaultRoleRequest, directoryView, revokeConsequence } from "./directory.ts";

const OLDER = {
  createdAt: "2026-10-01T09:00:00.000Z",
  createdBy: "01K000000000000000000000M1",
  id: "01K000000000000000000000T1",
  tokenPrefix: "dpl_scim_AAAAAAA",
};
const NEWER = {
  createdAt: "2026-10-09T09:00:00.000Z",
  createdBy: "01K000000000000000000000M2",
  id: "01K000000000000000000000T2",
  tokenPrefix: "dpl_scim_BBBBBBB",
};

const directory = (tokens: readonly (typeof OLDER)[]) =>
  Schema.decodeUnknownSync(DirectoryResponse)({
    createdAt: "2026-10-01T08:00:00.000Z",
    defaultRole: "member",
    scimBaseUrl: "https://api.example.test/scim/v2",
    tokens,
    updatedAt: "2026-10-01T08:00:00.000Z",
  });

describe("directoryView", () => {
  test("an organization without a directory shows sync as off", () => {
    expect(directoryView(null)).toEqual({ kind: "off" });
  });

  test("a directory without tokens asks for the first token", () => {
    const view = directoryView(directory([]));
    expect(view.kind === "on" ? view.slots : view).toEqual({ kind: "empty" });
  });

  test("one token leaves room for a rotation token", () => {
    const view = directoryView(directory([OLDER]));
    expect(view.kind === "on" ? view.slots : view).toEqual({ kind: "open" });
  });

  test("two tokens fill the directory and list newest first", () => {
    const view = directoryView(directory([OLDER, NEWER]));
    expect<unknown>(
      view.kind === "on" ? { ids: view.tokens.map(({ id }) => id), slots: view.slots } : view,
    ).toEqual({
      ids: ["01K000000000000000000000T2", "01K000000000000000000000T1"],
      slots: {
        kind: "full",
        reason:
          "A directory holds at most two tokens. Revoke the one your identity provider no longer uses, then create a new one.",
      },
    });
  });
});

describe("defaultRoleRequest", () => {
  test("turning sync on sends the chosen role", () => {
    expect(defaultRoleRequest(null, "member")).toEqual({
      body: { defaultRole: "member" },
      kind: "ready",
    });
  });

  test("a configured directory sends only a different role", () => {
    expect([
      defaultRoleRequest(directory([]), "member"),
      defaultRoleRequest(directory([]), "viewer"),
    ]).toEqual([{ kind: "unchanged" }, { body: { defaultRole: "viewer" }, kind: "ready" }]);
  });
});

describe("revokeConsequence", () => {
  test("revoking one of two tokens points at the other token", () => {
    const current = directory([OLDER, NEWER]);
    const [older] = current.tokens;
    expect(older && revokeConsequence(current, older)).toBe(
      "Requests with dpl_scim_AAAAAAA… get 401 at once. Move your identity provider to the other token first.",
    );
  });

  test("revoking the last token stops provisioning", () => {
    const current = directory([NEWER]);
    const [newer] = current.tokens;
    expect(newer && revokeConsequence(current, newer)).toBe(
      "Requests with dpl_scim_BBBBBBB… get 401 at once, and provisioning stops until you create a new token and paste it into your identity provider.",
    );
  });
});
