import { describe, expect, test } from "bun:test";
import { catalogFilters, parseCatalogSearch } from "./catalog-state.ts";
import { parseSimulationSearch, parseToolNames, simulationInput } from "./simulator-state.ts";

const POLICY = "01K00000000000000000000P01";
const DEPLOYMENT = "01K00000000000000000000D01";

describe("parseToolNames", () => {
  test("splits on spaces, commas, and new lines and drops duplicates", () => {
    expect(parseToolNames("github.issues.read, slack.post\n github.issues.read  a/b")).toEqual({
      invalid: [],
      names: ["github.issues.read", "slack.post", "a/b"],
      tooMany: false,
    });
  });

  test("reports names the contract rejects", () => {
    expect(parseToolNames("ok.tool .bad bad. -x").invalid).toEqual([".bad", "bad.", "-x"]);
  });

  test("flags more than 100 names", () => {
    const names = Array.from({ length: 101 }, (_, index) => `tool${index}`).join(" ");
    expect(parseToolNames(names).tooMany).toBe(true);
    expect(parseToolNames(names.split(" ").slice(0, 100).join(" ")).tooMany).toBe(false);
  });
});

describe("parseSimulationSearch", () => {
  test("defaults to the policy form and keeps valid, unique tool names", () => {
    expect(
      parseSimulationSearch({ policy: POLICY, tools: ["a.read", "a.read", "bad.", 7, "b.write"] }),
    ).toEqual({ against: "policy", policy: POLICY, tools: ["a.read", "b.write"] });
  });

  test("drops IDs that are not ULIDs and caps the list at 100", () => {
    const tools = Array.from({ length: 120 }, (_, index) => `tool${index}`);
    const search = parseSimulationSearch({ against: "deployment", deployment: "nope", tools });
    expect(search.against).toBe("deployment");
    expect(search.deployment).toBeUndefined();
    expect(search.tools).toHaveLength(100);
  });
});

describe("simulationInput", () => {
  test("the policy form needs a policy and at least one tool", () => {
    expect(simulationInput({ against: "policy", policy: POLICY, tools: [] })).toBeUndefined();
    expect(simulationInput({ against: "policy", tools: ["a.read"] })).toBeUndefined();
    expect(simulationInput({ against: "policy", policy: POLICY, tools: ["a.read"] })).toEqual({
      kind: "policy",
      toolNames: ["a.read"],
      toolPolicyId: POLICY,
    });
  });

  test("the deployment form needs only the deployment", () => {
    expect(
      simulationInput({ against: "deployment", deployment: DEPLOYMENT, tools: ["a.read"] }),
    ).toEqual({ agentDeploymentId: DEPLOYMENT, kind: "deployment" });
    expect(simulationInput({ against: "deployment", tools: [] })).toBeUndefined();
  });
});

describe("catalog search", () => {
  test("keeps known filters, trims text, and omits the default status", () => {
    const search = parseCatalogSearch({
      prefix: " github. ",
      provider: "github",
      search: "",
      status: "active",
      tool: "github.issues.read",
    });
    expect(search).toEqual({ prefix: "github.", provider: "github", tool: "github.issues.read" });
    expect(catalogFilters(search)).toEqual({ prefix: "github.", providerKey: "github" });
  });

  test("drops unknown statuses and over-long text", () => {
    expect(parseCatalogSearch({ search: "x".repeat(101), status: "deleted" })).toEqual({});
    expect(parseCatalogSearch({ status: "archived" })).toEqual({ status: "archived" });
  });
});
