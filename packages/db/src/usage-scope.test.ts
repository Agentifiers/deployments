import { describe, expect, test } from "bun:test";
import type { Ulid } from "./ids.ts";
import {
  SCOPE_LEVEL_IDS,
  SCOPE_LEVELS,
  scopeChain,
  scopeFieldsMatch,
  type ScopeLevel,
  type UsageScope,
} from "./usage-scope.ts";

const WORKSPACE_ID = "01J00000000000000000000WSP" as Ulid;
const SCOPE: UsageScope = {
  environmentId: "01J00000000000000000000ENV" as Ulid,
  organizationId: "01J000000000000000000000RG" as Ulid,
  projectId: "01J00000000000000000000PRJ" as Ulid,
  workspaceId: WORKSPACE_ID,
};
const ID_FIELDS = ["environmentId", "projectId", "workspaceId"] as const;
type IdField = (typeof ID_FIELDS)[number];

function fieldsOf(level: ScopeLevel, fields: readonly IdField[]) {
  return { scope: level, ...Object.fromEntries(fields.map((field) => [field, SCOPE[field]])) };
}

describe("usage scope", () => {
  test.each(SCOPE_LEVELS.map((level) => [level]))(
    "%s records match only with exactly their level's identifiers",
    (level) => {
      const own: readonly IdField[] = SCOPE_LEVEL_IDS[level];
      expect(scopeFieldsMatch(fieldsOf(level, own))).toBe(true);
      for (const field of ID_FIELDS) {
        const toggled = own.includes(field)
          ? own.filter((owned) => owned !== field)
          : [...own, field];
        expect(scopeFieldsMatch(fieldsOf(level, toggled))).toBe(false);
      }
    },
  );

  test("chains a scope from its workspace out to its organization", () => {
    expect(scopeChain(SCOPE)).toEqual([
      {
        environmentId: SCOPE.environmentId,
        projectId: SCOPE.projectId,
        scope: "workspace",
        workspaceId: WORKSPACE_ID,
      },
      { environmentId: SCOPE.environmentId, projectId: SCOPE.projectId, scope: "environment" },
      { projectId: SCOPE.projectId, scope: "project" },
      { scope: "organization" },
    ]);
  });

  test("starts the chain of a scope without a workspace at its environment", () => {
    expect(scopeChain({ ...SCOPE, workspaceId: undefined }).map((target) => target.scope)).toEqual([
      "environment",
      "project",
      "organization",
    ]);
  });

  test.each(SCOPE_LEVELS.map((level) => [level]))(
    "the %s target in a chain carries exactly the identifiers its records must",
    (level) => {
      const target = scopeChain(SCOPE).find((candidate) => candidate.scope === level);
      expect(target).toBeDefined();
      expect(scopeFieldsMatch(target!)).toBe(true);
    },
  );
});
