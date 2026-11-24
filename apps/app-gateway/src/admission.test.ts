import { describe, expect, test } from "bun:test";
import { memberRole } from "./admission.ts";

describe("memberRole", () => {
  test("takes the higher of the organization access level and the member's own grant", () => {
    expect([
      memberRole("none", undefined),
      memberRole("none", "viewer"),
      memberRole("viewer", undefined),
      memberRole("viewer", "viewer"),
      memberRole("viewer", "editor"),
      memberRole("editor", "viewer"),
      memberRole("none", "editor"),
    ]).toEqual([undefined, "viewer", "viewer", "viewer", "editor", "editor", "editor"]);
  });
});
