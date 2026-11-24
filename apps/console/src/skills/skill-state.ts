import { oneOf } from "../observability/range.ts";
import type { RouteResponse } from "../server/platform-api.ts";

type SkillResponse = RouteResponse<"getManagedSkill">;
type ReleaseResponse = RouteResponse<"getManagedSkillRelease">;
type SourceResponse = RouteResponse<"getManagedSkillSource">;
type InstallationResponse = RouteResponse<"getManagedSkillInstallation">;

export interface SkillSummary {
  readonly dependencies: readonly string[];
  readonly description?: string | undefined;
  readonly id: string;
  readonly key: string;
  readonly referenceCount: number;
  readonly releaseId: string;
  readonly sourceId: string;
}

export type ReleaseSummary = Pick<
  ReleaseResponse,
  | "activatedAt"
  | "archivedAt"
  | "createdAt"
  | "id"
  | "releaseVersion"
  | "skillCount"
  | "sourceId"
  | "status"
>;

export type SourceSummary = Pick<
  SourceResponse,
  "createdAt" | "id" | "key" | "name" | "pinnedCommit" | "repositoryUrl" | "status" | "version"
>;

export type SkillContent = Pick<SkillResponse, "content" | "id" | "key" | "referencePaths">;

export type InstallTarget =
  | { readonly kind: "environment" }
  | { readonly agentDefinitionId: string; readonly kind: "agent" };

export interface Installation {
  readonly createdAt: string;
  readonly id: string;
  readonly releaseId: string;
  readonly skillId: string;
  readonly target: InstallTarget;
  readonly version: number;
}

export interface AgentTarget {
  readonly id: string;
  readonly name: string;
  readonly status: string;
}

export type Health = "release_archived" | "serving" | "source_archived";

export type DependencyState =
  | { readonly kind: "missing" }
  | { readonly kind: "satisfied"; readonly via: "environment" | "same_target" };

export interface DependencyStatus {
  readonly key?: string | undefined;
  readonly skillId: string;
  readonly state: DependencyState;
}

export type Successor =
  | { readonly kind: "available"; readonly release: ReleaseSummary }
  | { readonly kind: "installed"; readonly release: ReleaseSummary };

export interface InstalledSkill {
  readonly dependencies: readonly DependencyStatus[];
  readonly health: Health;
  readonly installation: Installation;
  readonly release: ReleaseSummary;
  readonly skill: SkillSummary;
  readonly source: SourceSummary;
  readonly successor?: Successor | undefined;
}

export type InstallationGap = "dependencies" | "installations" | "releases";

export interface SkillInstallations {
  readonly gaps: readonly InstallationGap[];
  readonly installed: readonly InstalledSkill[];
}

export interface AgentTargets {
  readonly agents: readonly AgentTarget[];
  readonly complete: boolean;
}

export interface SkillSources {
  readonly complete: boolean;
  readonly sources: readonly SourceSummary[];
}

export interface ReleaseCatalog {
  readonly complete: boolean;
  readonly release: ReleaseSummary;
  readonly skills: readonly SkillSummary[];
  readonly source: SourceSummary;
}

export interface SourceCatalog {
  readonly complete: boolean;
  readonly releases: readonly ReleaseSummary[];
  readonly source: SourceSummary;
}

export const SOURCE_VIEWS = ["active", "all"] as const;
export type SourceView = (typeof SOURCE_VIEWS)[number];

export interface SourceSearch {
  readonly show?: "all";
}

export function parseSourceSearch(search: Readonly<Record<string, unknown>>): SourceSearch {
  return oneOf(SOURCE_VIEWS, search.show) === "all" ? { show: "all" } : {};
}

export function skillSummary(skill: SkillResponse): SkillSummary {
  return {
    dependencies: skill.dependencies,
    ...(skill.description === undefined ? {} : { description: skill.description }),
    id: skill.id,
    key: skill.key,
    referenceCount: skill.referencePaths.length,
    releaseId: skill.releaseId,
    sourceId: skill.sourceId,
  };
}

export function releaseSummary(release: ReleaseResponse): ReleaseSummary {
  const { activatedAt, archivedAt, createdAt, id, releaseVersion, skillCount, sourceId, status } =
    release;
  return {
    ...(activatedAt === undefined ? {} : { activatedAt }),
    ...(archivedAt === undefined ? {} : { archivedAt }),
    createdAt,
    id,
    releaseVersion,
    skillCount,
    sourceId,
    status,
  };
}

export function sourceSummary(source: SourceResponse): SourceSummary {
  const { createdAt, id, key, name, pinnedCommit, repositoryUrl, status, version } = source;
  return {
    createdAt,
    id,
    key,
    name,
    ...(pinnedCommit === undefined ? {} : { pinnedCommit }),
    ...(repositoryUrl === undefined ? {} : { repositoryUrl }),
    status,
    version,
  };
}

export function activeInstallations(
  installations: readonly InstallationResponse[],
): readonly Installation[] {
  return installations
    .filter((installation) => installation.status === "active")
    .map((installation) => ({
      createdAt: installation.createdAt,
      id: installation.id,
      releaseId: installation.managedSkillReleaseId,
      skillId: installation.managedSkillId,
      target:
        installation.agentDefinitionId === undefined
          ? { kind: "environment" }
          : { agentDefinitionId: installation.agentDefinitionId, kind: "agent" },
      version: installation.version,
    }));
}

function sameTarget(left: InstallTarget, right: InstallTarget): boolean {
  return left.kind === "environment"
    ? right.kind === "environment"
    : right.kind === "agent" && left.agentDefinitionId === right.agentDefinitionId;
}

export function dependencyState(
  skillId: string,
  target: InstallTarget,
  installations: readonly Pick<Installation, "skillId" | "target">[],
): DependencyState {
  const holders = installations.filter((installation) => installation.skillId === skillId);
  if (holders.some((installation) => sameTarget(installation.target, target))) {
    return { kind: "satisfied", via: "same_target" };
  }
  if (holders.some((installation) => installation.target.kind === "environment")) {
    return { kind: "satisfied", via: "environment" };
  }
  return { kind: "missing" };
}

const NUMERIC = /^\d+$/u;

function compareNumeric(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = NUMERIC.test(left);
  const rightNumeric = NUMERIC.test(right);
  if (leftNumeric && rightNumeric) return compareNumeric(left, right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareReleaseVersions(left: string, right: string): number {
  const [leftCore = "", ...leftPre] = left.split("+", 1)[0]?.split("-") ?? [];
  const [rightCore = "", ...rightPre] = right.split("+", 1)[0]?.split("-") ?? [];
  const leftParts = leftCore.split(".");
  const rightParts = rightCore.split(".");
  for (let index = 0; index < 3; index += 1) {
    const order = compareNumeric(leftParts[index] ?? "0", rightParts[index] ?? "0");
    if (order !== 0) return Math.sign(order);
  }
  const leftTag = leftPre.join("-");
  const rightTag = rightPre.join("-");
  if (leftTag === rightTag) return 0;
  if (leftTag === "") return 1;
  if (rightTag === "") return -1;
  const leftIds = leftTag.split(".");
  const rightIds = rightTag.split(".");
  for (let index = 0; index < Math.min(leftIds.length, rightIds.length); index += 1) {
    const order = compareIdentifier(leftIds[index] ?? "", rightIds[index] ?? "");
    if (order !== 0) return Math.sign(order);
  }
  return Math.sign(leftIds.length - rightIds.length);
}

export function newestReleaseFirst(releases: readonly ReleaseSummary[]): readonly ReleaseSummary[] {
  return releases.toSorted((left, right) =>
    compareReleaseVersions(right.releaseVersion, left.releaseVersion),
  );
}

function newerRelease(
  installed: ReleaseSummary,
  releases: readonly ReleaseSummary[],
): ReleaseSummary | undefined {
  return newestReleaseFirst(releases).find(
    (release) =>
      release.status === "active" &&
      release.sourceId === installed.sourceId &&
      compareReleaseVersions(release.releaseVersion, installed.releaseVersion) > 0,
  );
}

function health(release: ReleaseSummary, source: SourceSummary): Health {
  if (source.status === "archived") return "source_archived";
  return release.status === "archived" ? "release_archived" : "serving";
}

export interface CatalogLookup {
  readonly releases: ReadonlyMap<string, ReleaseSummary>;
  readonly releasesBySource: ReadonlyMap<string, readonly ReleaseSummary[]>;
  readonly skills: ReadonlyMap<string, SkillSummary>;
  readonly sources: ReadonlyMap<string, SourceSummary>;
}

export function installedSkills(
  installations: readonly Installation[],
  catalog: CatalogLookup,
): readonly InstalledSkill[] {
  const lookup = <Value>(map: ReadonlyMap<string, Value>, id: string, label: string): Value => {
    const value = map.get(id);
    if (value === undefined) throw new Error(`The skill catalog lookup is missing ${label} ${id}.`);
    return value;
  };
  const resolved = installations.map((installation) => {
    const skill = lookup(catalog.skills, installation.skillId, "skill");
    return {
      installation,
      release: lookup(catalog.releases, installation.releaseId, "release"),
      skill,
      source: lookup(catalog.sources, skill.sourceId, "source"),
    };
  });
  return resolved.map(({ installation, release, skill, source }) => {
    const newerInstalled = newestReleaseFirst(
      resolved
        .filter(
          (other) =>
            sameTarget(other.installation.target, installation.target) &&
            other.skill.sourceId === skill.sourceId &&
            other.skill.key === skill.key &&
            compareReleaseVersions(other.release.releaseVersion, release.releaseVersion) > 0,
        )
        .map((other) => other.release),
    )[0];
    const available = newerRelease(release, catalog.releasesBySource.get(source.id) ?? []);
    const successor: Successor | undefined = newerInstalled
      ? { kind: "installed", release: newerInstalled }
      : available && { kind: "available", release: available };
    return {
      dependencies: skill.dependencies.map((skillId) => ({
        key: catalog.skills.get(skillId)?.key,
        skillId,
        state: dependencyState(skillId, installation.target, installations),
      })),
      health: health(release, source),
      installation,
      release,
      skill,
      source,
      successor,
    };
  });
}

export type PlanStep =
  | {
      readonly kind: "install";
      readonly reason: "dependency" | "requested";
      readonly skill: SkillSummary;
      readonly target: InstallTarget;
    }
  | { readonly kind: "keep"; readonly skill: SkillSummary; readonly target: InstallTarget }
  | { readonly installed: InstalledSkill; readonly kind: "remove" };

export interface InstallPlan {
  readonly steps: readonly PlanStep[];
  readonly unresolved: readonly string[];
}

export type SkillOperation =
  | {
      readonly agentDefinitionId?: string;
      readonly kind: "install";
      readonly managedSkillId: string;
      readonly managedSkillReleaseId: string;
    }
  | { readonly expectedVersion: number; readonly installationId: string; readonly kind: "remove" };

export function installPlan({
  installed,
  releaseSkills,
  skill,
  target,
  withDependencies,
}: Readonly<{
  installed: readonly InstalledSkill[];
  releaseSkills: readonly SkillSummary[];
  skill: SkillSummary;
  target: InstallTarget;
  withDependencies: boolean;
}>): InstallPlan {
  const installations = installed.map(({ installation }) => installation);
  const bySkillId = new Map(
    [...installed.map((entry) => entry.skill), ...releaseSkills].map((entry) => [entry.id, entry]),
  );
  const visited = new Set<string>([skill.id]);
  const dependencies: PlanStep[] = [];
  const unresolved: string[] = [];
  const visit = (dependencyIds: readonly string[]) => {
    for (const dependencyId of dependencyIds) {
      if (visited.has(dependencyId)) continue;
      visited.add(dependencyId);
      const missing = dependencyState(dependencyId, target, installations).kind === "missing";
      const dependency = bySkillId.get(dependencyId);
      if (dependency === undefined) {
        if (missing) unresolved.push(dependencyId);
        continue;
      }
      visit(dependency.dependencies);
      if (missing) {
        dependencies.push({ kind: "install", reason: "dependency", skill: dependency, target });
      }
    }
  };
  if (withDependencies) visit(skill.dependencies);
  const requestedListed = installations.some(
    (it) => it.skillId === skill.id && sameTarget(it.target, target),
  );
  const replaced = installed.filter(
    (entry) =>
      sameTarget(entry.installation.target, target) &&
      entry.skill.sourceId === skill.sourceId &&
      entry.skill.key === skill.key &&
      entry.skill.id !== skill.id,
  );
  return {
    steps: [
      ...dependencies,
      requestedListed
        ? { kind: "keep", skill, target }
        : { kind: "install", reason: "requested", skill, target },
      ...replaced.map((entry): PlanStep => ({ installed: entry, kind: "remove" })),
    ],
    unresolved,
  };
}

export interface DependentsCheck {
  /** The plan removes an installation, and installations past the read may depend on it. */
  readonly partial: boolean;
  readonly stranded: readonly InstalledSkill[];
}

export function dependentsCheck(
  { gaps, installed }: SkillInstallations,
  steps: readonly PlanStep[],
): DependentsCheck {
  const removed = new Set(
    steps.flatMap((step) => (step.kind === "remove" ? [step.installed.installation.id] : [])),
  );
  const remaining = installed.filter((entry) => !removed.has(entry.installation.id));
  const after = [
    ...remaining.map(({ installation }) => installation),
    ...steps.flatMap((step) =>
      step.kind === "remove" ? [] : [{ skillId: step.skill.id, target: step.target }],
    ),
  ];
  const stranded = remaining.filter((entry) =>
    entry.dependencies.some(
      (dependency) =>
        dependency.state.kind === "satisfied" &&
        dependencyState(dependency.skillId, entry.installation.target, after).kind === "missing",
    ),
  );
  return { partial: removed.size > 0 && gaps.includes("installations"), stranded };
}

export type PlanAction = "downgrade" | "install" | "upgrade";

export function planAction(plan: readonly PlanStep[], releaseVersion: string): PlanAction {
  const removed = plan.flatMap((step) =>
    step.kind === "remove" ? [step.installed.release.releaseVersion] : [],
  );
  if (removed.some((version) => compareReleaseVersions(version, releaseVersion) > 0)) {
    return "downgrade";
  }
  return removed.length > 0 ? "upgrade" : "install";
}

export function planOperations(plan: readonly PlanStep[]): readonly SkillOperation[] {
  return plan.map((step): SkillOperation => {
    if (step.kind === "remove") {
      return {
        expectedVersion: step.installed.installation.version,
        installationId: step.installed.installation.id,
        kind: "remove",
      };
    }
    return {
      ...(step.target.kind === "agent" ? { agentDefinitionId: step.target.agentDefinitionId } : {}),
      kind: "install",
      managedSkillId: step.skill.id,
      managedSkillReleaseId: step.skill.releaseId,
    };
  });
}

export function stepIdempotencyKey(dialogKey: string, operation: SkillOperation): string {
  return operation.kind === "install"
    ? `${dialogKey}:install:${operation.managedSkillId}`
    : `${dialogKey}:remove:${operation.installationId}`;
}
