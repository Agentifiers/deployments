import { describe, expect, test } from "bun:test";
import { describeScopes, SCOPE_AREAS, SCOPE_CATALOG } from "./scope-catalog.ts";
import { PLATFORM_CLI_SCOPES, SUPPORTED_OAUTH_SCOPES } from "./tokens.ts";

describe("scope catalog", () => {
  test("describes every supported scope and nothing else", () => {
    expect(Object.keys(SCOPE_CATALOG).toSorted()).toEqual([...SUPPORTED_OAUTH_SCOPES].toSorted());
  });

  test("groups requested scopes by area and merges actions on one subject", () => {
    expect(
      describeScopes(["runs:write", "offline_access", "agents:read", "runs:read", "agents:write"]),
    ).toEqual([
      {
        area: "Your account",
        subjects: [{ actions: ["keep active until you sign out"], subject: "Your sign-in" }],
      },
      {
        area: "Agents and automation",
        subjects: [
          { actions: ["view", "create and change"], subject: "Agents" },
          { actions: ["view", "start and change"], subject: "Runs and threads" },
        ],
      },
    ]);
  });

  test("lists an unknown scope by its raw name instead of hiding it", () => {
    expect(describeScopes(["agents:read", "future:thing"])).toEqual([
      { area: "Agents and automation", subjects: [{ actions: ["view"], subject: "Agents" }] },
      { area: "Other access", subjects: [{ actions: ["allowed"], subject: "future:thing" }] },
    ]);
  });

  test("covers every scope the CLI requests in a known area", () => {
    const groups = describeScopes(PLATFORM_CLI_SCOPES);
    expect(groups.map((group) => group.area)).toEqual(
      SCOPE_AREAS.filter((area) => groups.some((group) => group.area === area)),
    );
    expect(groups.some((group) => group.area === "Other access")).toBeFalse();
  });
});
