import { describe, expect, test } from "bun:test";
import {
  ManagedSkillInstallationResponse,
  ManagedSkillReleaseResponse,
  ManagedSkillSourceResponse,
} from "@deployments-ai/api-contract";
import { Schema } from "effect";
import {
  activeInstallations,
  compareReleaseVersions,
  dependencyState,
  dependentsCheck,
  installedSkills,
  installPlan,
  planAction,
  parseSourceSearch,
  releaseSummary,
  sourceSummary,
  planOperations,
  stepIdempotencyKey,
  type CatalogLookup,
  type InstalledSkill,
  type Installation,
  type InstallationGap,
  type InstallPlan,
  type InstallTarget,
  type PlanStep,
  type ReleaseSummary,
  type SkillSummary,
  type SourceSummary,
} from "./skill-state.ts";

const ENVIRONMENT: InstallTarget = { kind: "environment" };
const AGENT: InstallTarget = { agentDefinitionId: "01M4CK1GWJARA9NEF7WAEV8QA1", kind: "agent" };
const OTHER_AGENT: InstallTarget = {
  agentDefinitionId: "01M4CK1GWJARA9NEF7WAEV8QA2",
  kind: "agent",
};

const SOURCE: SourceSummary = sourceSummary(
  Schema.decodeUnknownSync(ManagedSkillSourceResponse)({
    createdAt: "2026-10-01T00:00:00.000Z",
    id: "01M4CK1GECEFNJFHR05DBVE452",
    key: "console-qa-skills",
    metadata: { owner: "qa" },
    name: "Console QA skills",
    status: "active",
    updatedAt: "2026-10-01T00:00:00.000Z",
    version: 2,
  }),
);

function release(
  id: string,
  releaseVersion: string,
  status: "active" | "archived" = "active",
): ReleaseSummary {
  return releaseSummary(
    Schema.decodeUnknownSync(ManagedSkillReleaseResponse)({
      contentHash: `sha256:${"0".repeat(64)}`,
      createdAt: "2026-10-01T00:00:00.000Z",
      id,
      manifest: {},
      releaseVersion,
      skillCount: 2,
      sourceId: SOURCE.id,
      status,
      version: 1,
    }),
  );
}

describe("summaries", () => {
  test("drop the source metadata and the release manifest", () => {
    expect<object>(SOURCE).toEqual({
      createdAt: "2026-10-01T00:00:00.000Z",
      id: "01M4CK1GECEFNJFHR05DBVE452",
      key: "console-qa-skills",
      name: "Console QA skills",
      status: "active",
      version: 2,
    });
    expect<object>(release("01M4CK1GWJARA9NEF7WAEV8QV5", "1.0.0")).toEqual({
      createdAt: "2026-10-01T00:00:00.000Z",
      id: "01M4CK1GWJARA9NEF7WAEV8QV5",
      releaseVersion: "1.0.0",
      skillCount: 2,
      sourceId: "01M4CK1GECEFNJFHR05DBVE452",
      status: "active",
    });
  });
});

const V1 = release("01M4CK1GWJARA9NEF7WAEV8QV5", "1.0.0");
const V2 = release("01M4CK1HAK2KWR62793BEC7ZH0", "1.1.0");

function skill(id: string, key: string, of: ReleaseSummary, dependencies: string[] = []) {
  return {
    dependencies,
    id,
    key,
    referenceCount: 1,
    releaseId: of.id,
    sourceId: SOURCE.id,
  } satisfies SkillSummary;
}

const BASE_1 = skill("01M4CK1GWJARA9NEF7WAEV8QV3", "base", V1);
const EXTENDED_1 = skill("01M4CK1GWJARA9NEF7WAEV8QV4", "extended", V1, [BASE_1.id]);
const BASE_2 = skill("01M4CK1HAK2KWR62793BEC7ZGY", "base", V2);
const EXTENDED_2 = skill("01M4CK1HAK2KWR62793BEC7ZGZ", "extended", V2, [BASE_2.id]);

function installation(id: string, of: SkillSummary, target: InstallTarget): Installation {
  return {
    createdAt: "2026-10-02T00:00:00.000Z",
    id,
    releaseId: of.releaseId,
    skillId: of.id,
    target,
    version: 0,
  };
}

function catalog(releases: readonly ReleaseSummary[], sources = [SOURCE]): CatalogLookup {
  return {
    releases: new Map(releases.map((entry) => [entry.id, entry])),
    releasesBySource: new Map([[SOURCE.id, releases]]),
    skills: new Map([BASE_1, EXTENDED_1, BASE_2, EXTENDED_2].map((entry) => [entry.id, entry])),
    sources: new Map(sources.map((entry) => [entry.id, entry])),
  };
}

function installedOf(installations: readonly Installation[]): readonly InstalledSkill[] {
  return installedSkills(installations, catalog([V1, V2]));
}

describe("activeInstallations", () => {
  test("keeps active rows and reads the target from agentDefinitionId", () => {
    const rows = [
      { id: "01M4CK1GWJARA9NEF7WAEV8QB1", status: "active", agent: undefined },
      { id: "01M4CK1GWJARA9NEF7WAEV8QB2", status: "removed", agent: undefined },
      { id: "01M4CK1GWJARA9NEF7WAEV8QB3", status: "active", agent: AGENT.agentDefinitionId },
    ].map(({ agent, id, status }) =>
      Schema.decodeUnknownSync(ManagedSkillInstallationResponse)({
        ...(agent === undefined ? {} : { agentDefinitionId: agent }),
        createdAt: "2026-10-02T00:00:00.000Z",
        environmentId: "01M4CGZTV7TVHABD2TD30NADP2",
        id,
        installedByPrincipalId: "01ARZ3NDEKTSV4RRFFQ69G600B",
        managedSkillId: BASE_1.id,
        managedSkillReleaseId: V1.id,
        organizationId: "01ARZ3NDEKTSV4RRFFQ69G600C",
        projectId: "01ARZ3NDEKTSV4RRFFQ69G600D",
        status,
        updatedAt: "2026-10-02T00:00:00.000Z",
        version: 3,
      }),
    );
    expect(activeInstallations(rows)).toEqual([
      {
        createdAt: "2026-10-02T00:00:00.000Z",
        id: "01M4CK1GWJARA9NEF7WAEV8QB1",
        releaseId: V1.id,
        skillId: BASE_1.id,
        target: { kind: "environment" },
        version: 3,
      },
      {
        createdAt: "2026-10-02T00:00:00.000Z",
        id: "01M4CK1GWJARA9NEF7WAEV8QB3",
        releaseId: V1.id,
        skillId: BASE_1.id,
        target: { agentDefinitionId: "01M4CK1GWJARA9NEF7WAEV8QA1", kind: "agent" },
        version: 3,
      },
    ]);
  });
});

describe("dependencyState", () => {
  test("an installation for the same agent satisfies it first", () => {
    const installations = [
      installation("01M4CK1GWJARA9NEF7WAEV8QB1", BASE_1, AGENT),
      installation("01M4CK1GWJARA9NEF7WAEV8QB2", BASE_1, ENVIRONMENT),
    ];
    expect(dependencyState(BASE_1.id, AGENT, installations)).toEqual({
      kind: "satisfied",
      via: "same_target",
    });
  });

  test("an environment installation serves every agent", () => {
    const installations = [installation("01M4CK1GWJARA9NEF7WAEV8QB2", BASE_1, ENVIRONMENT)];
    expect(dependencyState(BASE_1.id, AGENT, installations)).toEqual({
      kind: "satisfied",
      via: "environment",
    });
  });

  test("another agent's installation does not serve this agent or the environment", () => {
    const installations = [installation("01M4CK1GWJARA9NEF7WAEV8QB1", BASE_1, OTHER_AGENT)];
    expect(dependencyState(BASE_1.id, AGENT, installations)).toEqual({ kind: "missing" });
    expect(dependencyState(BASE_1.id, ENVIRONMENT, installations)).toEqual({ kind: "missing" });
  });

  test("another release of the same key is a different skill", () => {
    const installations = [installation("01M4CK1GWJARA9NEF7WAEV8QB1", BASE_2, ENVIRONMENT)];
    expect(dependencyState(BASE_1.id, ENVIRONMENT, installations)).toEqual({ kind: "missing" });
  });
});

describe("installedSkills", () => {
  test("joins dependencies, health, and the newest active release above the installed one", () => {
    const extended = installation("01M4CK1GWJARA9NEF7WAEV8QB1", EXTENDED_1, ENVIRONMENT);
    const base = installation("01M4CK1GWJARA9NEF7WAEV8QB2", BASE_1, AGENT);
    const v3 = release("01M4CK1HAK2KWR62793BEC7ZH9", "1.2.0", "archived");
    const [first, second] = installedSkills([extended, base], catalog([V1, V2, v3]));
    expect(first?.dependencies).toEqual([
      { key: "base", skillId: BASE_1.id, state: { kind: "missing" } },
    ]);
    expect(first?.health).toBe("serving");
    expect(first?.successor).toEqual({ kind: "available", release: V2 });
    expect(second?.dependencies).toEqual([]);
  });

  test("an archived release or source is reported, source first", () => {
    const archived = release(V1.id, "1.0.0", "archived");
    const extended = installation("01M4CK1GWJARA9NEF7WAEV8QB1", EXTENDED_1, ENVIRONMENT);
    expect(installedSkills([extended], catalog([archived, V2]))[0]?.health).toBe(
      "release_archived",
    );
    const archivedSource = { ...SOURCE, status: "archived" as const };
    expect(installedSkills([extended], catalog([archived], [archivedSource]))[0]?.health).toBe(
      "source_archived",
    );
  });

  test("the newest release has nothing newer", () => {
    const extended = installation("01M4CK1GWJARA9NEF7WAEV8QB1", EXTENDED_2, ENVIRONMENT);
    expect(installedOf([extended])[0]?.successor).toBeUndefined();
  });

  test("a newer release installed for the same target supersedes the older one there", () => {
    const [older, newer, elsewhere] = installedOf([
      installation("01M4CK1GWJARA9NEF7WAEV8QB2", BASE_1, ENVIRONMENT),
      installation("01M4CK1GWJARA9NEF7WAEV8QB5", BASE_2, ENVIRONMENT),
      installation("01M4CK1GWJARA9NEF7WAEV8QB6", BASE_1, AGENT),
    ]);
    expect(older?.successor).toEqual({ kind: "installed", release: V2 });
    expect(newer?.successor).toBeUndefined();
    expect(elsewhere?.successor).toEqual({ kind: "available", release: V2 });
  });

  test("a dependency the loader did not read keeps its state without a key", () => {
    const extended = installation("01M4CK1GWJARA9NEF7WAEV8QB1", EXTENDED_1, ENVIRONMENT);
    const lookup = catalog([V1, V2]);
    const skills = new Map(lookup.skills);
    skills.delete(BASE_1.id);
    expect(installedSkills([extended], { ...lookup, skills })[0]?.dependencies).toEqual([
      { skillId: BASE_1.id, state: { kind: "missing" } },
    ]);
  });

  test("a catalog gap is a loader bug", () => {
    const extended = installation("01M4CK1GWJARA9NEF7WAEV8QB1", EXTENDED_1, ENVIRONMENT);
    expect(() => installedSkills([extended], catalog([V2]))).toThrow(
      "The skill catalog lookup is missing release 01M4CK1GWJARA9NEF7WAEV8QV5.",
    );
  });
});

describe("installPlan", () => {
  const version = (of: SkillSummary) => (of.releaseId === V1.id ? "1.0.0" : "1.1.0");
  const describePlan = ({ steps, unresolved }: InstallPlan) => ({
    steps: steps.map((step) =>
      step.kind === "install"
        ? `install ${step.skill.key}@${version(step.skill)} (${step.reason})`
        : step.kind === "keep"
          ? `keep ${step.skill.key}@${version(step.skill)}`
          : `remove ${step.installed.installation.id}`,
    ),
    unresolved,
  });

  test("installs missing dependencies first, then the skill", () => {
    const plan = installPlan({
      installed: [],
      releaseSkills: [BASE_1, EXTENDED_1],
      skill: EXTENDED_1,
      target: ENVIRONMENT,
      withDependencies: true,
    });
    expect(describePlan(plan)).toEqual({
      steps: ["install base@1.0.0 (dependency)", "install extended@1.0.0 (requested)"],
      unresolved: [],
    });
  });

  test("installs dependencies deepest first and once, even through a cycle", () => {
    const a = skill("01M4CK1GWJARA9NEF7WAEV8QC1", "a", V1, ["01M4CK1GWJARA9NEF7WAEV8QC2"]);
    const b = skill("01M4CK1GWJARA9NEF7WAEV8QC2", "b", V1, ["01M4CK1GWJARA9NEF7WAEV8QC3"]);
    const c = skill("01M4CK1GWJARA9NEF7WAEV8QC3", "c", V1, [a.id]);
    const { steps } = installPlan({
      installed: [],
      releaseSkills: [a, b, c],
      skill: a,
      target: AGENT,
      withDependencies: true,
    });
    expect(steps.map((step) => (step.kind === "remove" ? "remove" : step.skill.key))).toEqual([
      "c",
      "b",
      "a",
    ]);
  });

  test("skips dependencies the environment already serves", () => {
    const installed = installedOf([
      installation("01M4CK1GWJARA9NEF7WAEV8QB2", BASE_1, ENVIRONMENT),
    ]);
    const plan = installPlan({
      installed,
      releaseSkills: [BASE_1, EXTENDED_1],
      skill: EXTENDED_1,
      target: AGENT,
      withDependencies: true,
    });
    expect(describePlan(plan)).toEqual({
      steps: ["install extended@1.0.0 (requested)"],
      unresolved: [],
    });
  });

  test("leaves dependencies out when asked", () => {
    const plan = installPlan({
      installed: [],
      releaseSkills: [EXTENDED_1],
      skill: EXTENDED_1,
      target: ENVIRONMENT,
      withDependencies: false,
    });
    expect(describePlan(plan)).toEqual({
      steps: ["install extended@1.0.0 (requested)"],
      unresolved: [],
    });
  });

  test("names a missing dependency the partial release list lacks instead of dropping it", () => {
    const plan = installPlan({
      installed: [],
      releaseSkills: [EXTENDED_1],
      skill: EXTENDED_1,
      target: ENVIRONMENT,
      withDependencies: true,
    });
    expect(describePlan(plan)).toEqual({
      steps: ["install extended@1.0.0 (requested)"],
      unresolved: ["01M4CK1GWJARA9NEF7WAEV8QV3"],
    });
  });

  test("resolves a dependency the partial release list lacks from an installed copy", () => {
    const installed = installedOf([installation("01M4CK1GWJARA9NEF7WAEV8QB2", BASE_1, AGENT)]);
    const plan = installPlan({
      installed,
      releaseSkills: [EXTENDED_1],
      skill: EXTENDED_1,
      target: ENVIRONMENT,
      withDependencies: true,
    });
    expect(describePlan(plan)).toEqual({
      steps: ["install base@1.0.0 (dependency)", "install extended@1.0.0 (requested)"],
      unresolved: [],
    });
  });

  test("only keeps the skill when the target already lists it", () => {
    const installed = installedOf([
      installation("01M4CK1GWJARA9NEF7WAEV8QB2", BASE_1, ENVIRONMENT),
    ]);
    const plan = installPlan({
      installed,
      releaseSkills: [BASE_1, EXTENDED_1],
      skill: BASE_1,
      target: ENVIRONMENT,
      withDependencies: true,
    });
    expect(describePlan(plan)).toEqual({ steps: ["keep base@1.0.0"], unresolved: [] });
  });

  test("an upgrade installs the new release and then removes the old one for that target only", () => {
    const installed = installedOf([
      installation("01M4CK1GWJARA9NEF7WAEV8QB1", EXTENDED_1, ENVIRONMENT),
      installation("01M4CK1GWJARA9NEF7WAEV8QB2", BASE_1, ENVIRONMENT),
      installation("01M4CK1GWJARA9NEF7WAEV8QB3", EXTENDED_1, AGENT),
    ]);
    const plan = installPlan({
      installed,
      releaseSkills: [BASE_2, EXTENDED_2],
      skill: EXTENDED_2,
      target: ENVIRONMENT,
      withDependencies: true,
    });
    expect(describePlan(plan).steps).toEqual([
      "install base@1.1.0 (dependency)",
      "install extended@1.1.0 (requested)",
      "remove 01M4CK1GWJARA9NEF7WAEV8QB1",
    ]);
  });

  test("a retry after the new release installed keeps it, then removes the old one", () => {
    const installed = installedOf([
      installation("01M4CK1GWJARA9NEF7WAEV8QB1", EXTENDED_1, ENVIRONMENT),
      installation("01M4CK1GWJARA9NEF7WAEV8QB2", BASE_1, ENVIRONMENT),
      installation("01M4CK1GWJARA9NEF7WAEV8QB4", BASE_2, ENVIRONMENT),
      installation("01M4CK1GWJARA9NEF7WAEV8QB5", EXTENDED_2, ENVIRONMENT),
    ]);
    const plan = installPlan({
      installed,
      releaseSkills: [BASE_2, EXTENDED_2],
      skill: EXTENDED_2,
      target: ENVIRONMENT,
      withDependencies: true,
    });
    expect(describePlan(plan).steps).toEqual([
      "keep extended@1.1.0",
      "remove 01M4CK1GWJARA9NEF7WAEV8QB1",
    ]);
  });
});

interface Planned {
  readonly installed: readonly InstalledSkill[];
  readonly steps: readonly PlanStep[];
}

const planOf = (current: readonly Installation[], requested: SkillSummary): Planned => {
  const installed = installedOf(current);
  const { steps } = installPlan({
    installed,
    releaseSkills: [requested],
    skill: requested,
    target: ENVIRONMENT,
    withDependencies: true,
  });
  return { installed, steps };
};

describe("dependentsCheck", () => {
  const check = ({ installed, steps }: Planned, gaps: readonly InstallationGap[] = []) => {
    const { partial, stranded } = dependentsCheck({ gaps, installed }, steps);
    return { partial, stranded: stranded.map(({ installation: { id } }) => id) };
  };
  const stranded = (current: readonly Installation[], requested: SkillSummary) =>
    check(planOf(current, requested)).stranded;

  test("replacing a release with an older one names the skills that depend on the newer one", () => {
    expect(
      stranded(
        [
          installation("01M4CK1GWJARA9NEF7WAEV8QB4", BASE_2, ENVIRONMENT),
          installation("01M4CK1GWJARA9NEF7WAEV8QB5", EXTENDED_2, ENVIRONMENT),
        ],
        BASE_1,
      ),
    ).toEqual(["01M4CK1GWJARA9NEF7WAEV8QB5"]);
  });

  test("an upgrade names an agent's skill that the environment's old release served", () => {
    expect(
      stranded(
        [
          installation("01M4CK1GWJARA9NEF7WAEV8QB2", BASE_1, ENVIRONMENT),
          installation("01M4CK1GWJARA9NEF7WAEV8QB3", EXTENDED_1, AGENT),
        ],
        BASE_2,
      ),
    ).toEqual(["01M4CK1GWJARA9NEF7WAEV8QB3"]);
  });

  test("an upgrade that also replaces the dependent strands nothing", () => {
    expect(
      stranded(
        [
          installation("01M4CK1GWJARA9NEF7WAEV8QB1", EXTENDED_1, ENVIRONMENT),
          installation("01M4CK1GWJARA9NEF7WAEV8QB2", BASE_1, ENVIRONMENT),
        ],
        EXTENDED_2,
      ),
    ).toEqual([]);
  });

  test("removing the older release names its dependents unless their own target still has it", () => {
    const installed = installedOf([
      installation("01M4CK1GWJARA9NEF7WAEV8QB2", BASE_1, ENVIRONMENT),
      installation("01M4CK1GWJARA9NEF7WAEV8QB4", BASE_2, ENVIRONMENT),
      installation("01M4CK1GWJARA9NEF7WAEV8QB3", EXTENDED_1, AGENT),
      installation("01M4CK1GWJARA9NEF7WAEV8QB6", BASE_1, OTHER_AGENT),
      installation("01M4CK1GWJARA9NEF7WAEV8QB7", EXTENDED_1, OTHER_AGENT),
    ]);
    const older = installed.find(({ installation: { id } }) => id === "01M4CK1GWJARA9NEF7WAEV8QB2");
    if (older === undefined) throw new Error("fixture lists the older release");
    const { partial, stranded } = dependentsCheck({ gaps: [], installed }, [
      { installed: older, kind: "remove" },
    ]);
    expect({ partial, stranded: stranded.map(({ installation: { id } }) => id) }).toEqual({
      partial: false,
      stranded: ["01M4CK1GWJARA9NEF7WAEV8QB3"],
    });
  });

  test("an upgrade past the installations the console read is partial", () => {
    const plan = planOf([installation("01M4CK1GWJARA9NEF7WAEV8QB2", BASE_1, ENVIRONMENT)], BASE_2);
    expect({
      action: planAction(plan.steps, "1.1.0"),
      ...check(plan, ["installations"]),
    }).toEqual({ action: "upgrade", partial: true, stranded: [] });
  });

  test("a downgrade past the installations the console read is partial", () => {
    const plan = planOf([installation("01M4CK1GWJARA9NEF7WAEV8QB4", BASE_2, ENVIRONMENT)], BASE_1);
    expect({
      action: planAction(plan.steps, "1.0.0"),
      ...check(plan, ["installations"]),
    }).toEqual({ action: "downgrade", partial: true, stranded: [] });
  });

  test("a removal past the installations the console read is partial", () => {
    const installed = installedOf([
      installation("01M4CK1GWJARA9NEF7WAEV8QB2", BASE_1, ENVIRONMENT),
    ]);
    const [only] = installed;
    if (only === undefined) throw new Error("fixture lists the installation");
    const { partial, stranded } = dependentsCheck({ gaps: ["installations"], installed }, [
      { installed: only, kind: "remove" },
    ]);
    expect({ partial, stranded }).toEqual({ partial: true, stranded: [] });
  });

  test("partial stays false when the plan removes nothing, even past the installations read", () => {
    expect(check(planOf([], BASE_1), ["installations"])).toEqual({ partial: false, stranded: [] });
  });

  test("partial stays false when only dependencies or releases were cut short", () => {
    expect(
      check(planOf([installation("01M4CK1GWJARA9NEF7WAEV8QB2", BASE_1, ENVIRONMENT)], BASE_2), [
        "dependencies",
        "releases",
      ]),
    ).toEqual({ partial: false, stranded: [] });
  });
});

describe("planAction", () => {
  test("names the plan by the direction of the release it replaces", () => {
    expect(planAction(planOf([], BASE_1).steps, "1.0.0")).toBe("install");
    const newer = [installation("01M4CK1GWJARA9NEF7WAEV8QB5", BASE_2, ENVIRONMENT)];
    expect(planAction(planOf(newer, BASE_1).steps, "1.0.0")).toBe("downgrade");
    const older = [installation("01M4CK1GWJARA9NEF7WAEV8QB2", BASE_1, ENVIRONMENT)];
    expect(planAction(planOf(older, BASE_2).steps, "1.1.0")).toBe("upgrade");
  });
});

describe("planOperations and stepIdempotencyKey", () => {
  test("derive one call and one key per step", () => {
    const installed = installedOf([
      { ...installation("01M4CK1GWJARA9NEF7WAEV8QB1", EXTENDED_1, AGENT), version: 4 },
    ]);
    const operations = planOperations(
      installPlan({
        installed,
        releaseSkills: [BASE_2, EXTENDED_2],
        skill: EXTENDED_2,
        target: AGENT,
        withDependencies: false,
      }).steps,
    );
    expect(operations).toEqual([
      {
        agentDefinitionId: "01M4CK1GWJARA9NEF7WAEV8QA1",
        kind: "install",
        managedSkillId: EXTENDED_2.id,
        managedSkillReleaseId: V2.id,
      },
      { expectedVersion: 4, installationId: "01M4CK1GWJARA9NEF7WAEV8QB1", kind: "remove" },
    ]);
    expect(operations.map((operation) => stepIdempotencyKey("dialog", operation))).toEqual([
      "dialog:install:01M4CK1HAK2KWR62793BEC7ZGZ",
      "dialog:remove:01M4CK1GWJARA9NEF7WAEV8QB1",
    ]);
  });

  test("a stale cache that lists the requested release still sends its install before the remove", () => {
    const installed = installedOf([
      installation("01M4CK1GWJARA9NEF7WAEV8QB2", BASE_1, ENVIRONMENT),
      installation("01M4CK1GWJARA9NEF7WAEV8QB4", BASE_2, ENVIRONMENT),
    ]);
    const operations = planOperations(
      installPlan({
        installed,
        releaseSkills: [BASE_2],
        skill: BASE_2,
        target: ENVIRONMENT,
        withDependencies: true,
      }).steps,
    );
    expect(operations).toEqual([
      { kind: "install", managedSkillId: BASE_2.id, managedSkillReleaseId: V2.id },
      { expectedVersion: 0, installationId: "01M4CK1GWJARA9NEF7WAEV8QB2", kind: "remove" },
    ]);
  });

  test("an environment install sends no agent", () => {
    const [operation] = planOperations([
      { kind: "install", reason: "requested", skill: BASE_1, target: ENVIRONMENT },
    ]);
    expect(operation).toEqual({
      kind: "install",
      managedSkillId: BASE_1.id,
      managedSkillReleaseId: V1.id,
    });
  });
});

describe("compareReleaseVersions", () => {
  test.each([
    ["1.0.0", "1.0.1", -1],
    ["1.10.0", "1.9.0", 1],
    ["2.0.0", "10.0.0", -1],
    ["1.0.0-alpha", "1.0.0", -1],
    ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta", -1],
    ["1.0.0-beta.2", "1.0.0-beta.11", -1],
    ["1.0.0-rc.1", "1.0.0-beta.11", 1],
    ["1.0.0+build.1", "1.0.0+build.2", 0],
    ["1.0.0-x-y", "1.0.0-x-z", -1],
  ] as const)("%s against %s is %d", (left, right, expected) => {
    expect(compareReleaseVersions(left, right)).toBe(expected);
    expect(compareReleaseVersions(right, left)).toBe(expected === 0 ? 0 : -expected);
  });
});

describe("parseSourceSearch", () => {
  test("keeps only show=all", () => {
    expect(parseSourceSearch({ show: "all" })).toEqual({ show: "all" });
    expect(parseSourceSearch({ show: "active" })).toEqual({});
    expect(parseSourceSearch({ show: 3 })).toEqual({});
  });
});
