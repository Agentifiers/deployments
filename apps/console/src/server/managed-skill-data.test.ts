import { describe, expect, test } from "bun:test";
import {
  loadAgentTargets,
  loadSkillInstallations,
  loadSourceCatalog,
} from "./managed-skill-data.ts";
import type { callRoute } from "./platform-api.ts";

const SCOPE = {
  environmentId: "01M4CGZTV7TVHABD2TD30NADP2",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G600C",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G600D",
};

type Input = { readonly path?: { readonly id: string }; readonly query?: { cursor?: string } };
type Responses = Readonly<Record<string, (input: Input) => unknown>>;

function platform(responses: Responses) {
  const calls: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const fake = async (name: string, input: Input) => {
    calls.push(name);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await Promise.resolve();
    inFlight -= 1;
    const respond = responses[name];
    if (!respond) throw new Error(`unexpected ${name}`);
    return respond(input);
  };
  return { call: fake as unknown as typeof callRoute, calls, peak: () => peak };
}

const id = (prefix: string, index: number) => `${prefix}${String(index).padStart(4, "0")}`;

const source = ({ path }: Input) => ({
  createdAt: "2026-10-01T00:00:00.000Z",
  id: path?.id,
  key: `key-${path?.id}`,
  name: `Source ${path?.id}`,
  status: "active",
  version: 1,
});

const release = (releaseId: string, sourceId: string, releaseVersion: string) => ({
  createdAt: "2026-10-01T00:00:00.000Z",
  id: releaseId,
  releaseVersion,
  skillCount: 1,
  sourceId,
  status: "active",
});

function endless<Item>(item: (index: number) => Item) {
  return ({ query }: Input) => {
    const index = Number(query?.cursor ?? 0);
    return { items: [item(index)], nextCursor: String(index + 1) };
  };
}

function installation(index: number, releaseId = id("REL", index)) {
  return {
    createdAt: "2026-10-02T00:00:00.000Z",
    id: id("INS", index),
    managedSkillId: id("SKL", index),
    managedSkillReleaseId: releaseId,
    status: "active",
    version: 1,
  };
}

const skill = ({ path }: Input) => {
  const index = Number(path?.id.slice(3));
  return {
    dependencies: [],
    id: path?.id,
    key: "skill",
    referencePaths: [],
    releaseId: id("REL", index),
    sourceId: id("SRC", index),
  };
};

describe("loadSkillInstallations", () => {
  test("keeps at most four API requests in flight across six sources", async () => {
    const { call, peak } = platform({
      getManagedSkill: skill,
      getManagedSkillSource: source,
      listManagedSkillInstallations: () => ({
        items: [0, 1, 2, 3, 4, 5].map((index) => installation(index)),
      }),
      listManagedSkillReleases: ({ path }) => {
        const index = Number(path?.id.slice(3));
        return { items: [release(id("REL", index), id("SRC", index), "1.0.0")] };
      },
    });
    const { installed } = await loadSkillInstallations("token", SCOPE, call);
    expect<readonly string[]>(installed.map((entry) => entry.source.id)).toEqual([
      "SRC0000",
      "SRC0001",
      "SRC0002",
      "SRC0003",
      "SRC0004",
      "SRC0005",
    ]);
    expect(peak()).toBe(4);
  });

  test("reads an installed release past the release cap by ID and reports the gap", async () => {
    const { call, calls } = platform({
      getManagedSkill: skill,
      getManagedSkillRelease: () => release(id("REL", 0), id("SRC", 0), "0.1.0"),
      getManagedSkillSource: source,
      listManagedSkillInstallations: () => ({ items: [installation(0)] }),
      listManagedSkillReleases: endless((index) =>
        release(id("OLD", index), id("SRC", 0), `1.0.${index}`),
      ),
    });
    const { gaps, installed } = await loadSkillInstallations("token", SCOPE, call);
    expect(installed[0]?.release.releaseVersion).toBe("0.1.0");
    expect<object | undefined>(installed[0]?.successor).toEqual({
      kind: "available",
      release: release(id("OLD", 19), id("SRC", 0), "1.0.19"),
    });
    expect(gaps).toEqual(["releases"]);
    expect(calls.filter((name) => name === "listManagedSkillReleases")).toHaveLength(20);
  });
});

describe("page caps", () => {
  test("a source's releases stop after 20 pages and report the list incomplete", async () => {
    const { call, calls } = platform({
      getManagedSkillSource: source,
      listManagedSkillReleases: endless((index) =>
        release(id("REL", index), id("SRC", 0), `1.0.${index}`),
      ),
    });
    const catalog = await loadSourceCatalog("token", id("SRC", 0), call);
    expect(catalog.complete).toBe(false);
    expect(catalog.releases).toHaveLength(20);
    expect(calls.filter((name) => name === "listManagedSkillReleases")).toHaveLength(20);
  });

  test("agent targets stop after 20 pages and report the list incomplete", async () => {
    const { call } = platform({
      listAgentDefinitions: endless((index) => ({
        id: id("AGT", index),
        name: `agent ${index}`,
        status: "active",
      })),
    });
    const targets = await loadAgentTargets("token", SCOPE, call);
    expect(targets.complete).toBe(false);
    expect(targets.agents).toHaveLength(20);
  });
});
