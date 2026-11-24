import { describe, expect, test } from "bun:test";
import { nextSetupStep } from "./setup.ts";

describe("nextSetupStep", () => {
  test("asks for a project, then an environment in the first active project", () => {
    expect(nextSetupStep([])).toEqual({ kind: "create-project" });
    expect(nextSetupStep([{ environments: [], project: { id: "P1", status: "active" } }])).toEqual({
      kind: "create-environment",
      projectId: "P1",
    });
    expect(
      nextSetupStep([{ environments: [], project: { id: "P1", status: "archived" } }]),
    ).toEqual({ kind: "create-project" });
  });

  test("is ready once any project has an environment", () => {
    expect(
      nextSetupStep([
        { environments: [], project: { id: "P1", status: "active" } },
        { environments: [{ id: "E1" }], project: { id: "P2", status: "active" } },
      ]),
    ).toEqual({ kind: "ready" });
  });
});
