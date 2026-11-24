import "@tanstack/react-start/server-only";
import { collectPagesUpTo } from "../overview/status-counts.ts";
import type { EnvironmentScope } from "../scope.ts";
import {
  activeInstallations,
  installedSkills,
  releaseSummary,
  skillSummary,
  sourceSummary,
  type AgentTargets,
  type InstallationGap,
  type ReleaseCatalog,
  type ReleaseSummary,
  type SkillContent,
  type SkillInstallations,
  type SkillSources,
  type SkillSummary,
  type SourceCatalog,
  type SourceSummary,
} from "../skills/skill-state.ts";
import { fanOut } from "./fan-out.ts";
import { API_PAGE_LIMIT } from "./list-pages.ts";
import { callRoute as platformCallRoute } from "./platform-api.ts";

type CallRoute = typeof platformCallRoute;

const MAX_PAGES = 20;
const MAX_INSTALLED_SKILLS = 200;
const MAX_DEPENDENCY_READS = 200;

function readSkills(
  callRoute: CallRoute,
  accessToken: string,
  ids: readonly string[],
): Promise<SkillSummary[]> {
  return fanOut(ids, async (id) =>
    skillSummary(await callRoute("getManagedSkill", { path: { id } }, accessToken)),
  );
}

async function listReleases(
  callRoute: CallRoute,
  accessToken: string,
  sourceId: string,
): Promise<{ readonly complete: boolean; readonly releases: readonly ReleaseSummary[] }> {
  const { complete, items } = await collectPagesUpTo(
    (cursor) =>
      callRoute(
        "listManagedSkillReleases",
        { path: { id: sourceId }, query: { cursor, limit: API_PAGE_LIMIT } },
        accessToken,
      ),
    MAX_PAGES,
  );
  return { complete, releases: items.map(releaseSummary) };
}

async function readSource(
  callRoute: CallRoute,
  accessToken: string,
  id: string,
): Promise<SourceSummary> {
  return sourceSummary(await callRoute("getManagedSkillSource", { path: { id } }, accessToken));
}

export async function loadSkillInstallations(
  accessToken: string,
  scope: EnvironmentScope,
  callRoute: CallRoute = platformCallRoute,
): Promise<SkillInstallations> {
  const listed = await collectPagesUpTo(
    (cursor) =>
      callRoute(
        "listManagedSkillInstallations",
        { query: { cursor, limit: API_PAGE_LIMIT }, scope },
        accessToken,
      ),
    MAX_PAGES,
  );
  const active = activeInstallations(listed.items);
  const skillIds = [...new Set(active.map((installation) => installation.skillId))].slice(
    0,
    MAX_INSTALLED_SKILLS,
  );
  const shownSkillIds = new Set(skillIds);
  const shown = active.filter((installation) => shownSkillIds.has(installation.skillId));
  const installed = await readSkills(callRoute, accessToken, skillIds);
  const dependencyIds = [...new Set(installed.flatMap((skill) => skill.dependencies))].filter(
    (id) => !shownSkillIds.has(id),
  );
  const dependencies = await readSkills(
    callRoute,
    accessToken,
    dependencyIds.slice(0, MAX_DEPENDENCY_READS),
  );
  const sourceIds = [...new Set(installed.map((skill) => skill.sourceId))];
  const sources = await fanOut(sourceIds, async (id) => {
    const source = await readSource(callRoute, accessToken, id);
    return { ...(await listReleases(callRoute, accessToken, id)), source };
  });
  const releases = new Map<string, ReleaseSummary>(
    sources.flatMap((entry) => entry.releases).map((release) => [release.id, release]),
  );
  const unlisted = [...new Set(shown.map((installation) => installation.releaseId))].filter(
    (id) => !releases.has(id),
  );
  const read = await fanOut(unlisted, async (id) =>
    releaseSummary(await callRoute("getManagedSkillRelease", { path: { id } }, accessToken)),
  );
  for (const release of read) releases.set(release.id, release);
  const gaps = (
    [
      ["installations", !listed.complete || shown.length < active.length],
      ["dependencies", dependencyIds.length > MAX_DEPENDENCY_READS],
      ["releases", sources.some((entry) => !entry.complete)],
    ] as const satisfies readonly (readonly [InstallationGap, boolean])[]
  ).flatMap(([gap, open]) => (open ? [gap] : []));
  return {
    gaps,
    installed: installedSkills(shown, {
      releases,
      releasesBySource: new Map(sources.map((entry) => [entry.source.id, entry.releases])),
      skills: new Map([...installed, ...dependencies].map((skill) => [skill.id, skill])),
      sources: new Map(sources.map((entry) => [entry.source.id, entry.source])),
    }),
  };
}

export async function loadAgentTargets(
  accessToken: string,
  scope: EnvironmentScope,
  callRoute: CallRoute = platformCallRoute,
): Promise<AgentTargets> {
  const { complete, items } = await collectPagesUpTo(
    (cursor) =>
      callRoute(
        "listAgentDefinitions",
        { query: { cursor, limit: API_PAGE_LIMIT }, scope },
        accessToken,
      ),
    MAX_PAGES,
  );
  return { agents: items.map(({ id, name, status }) => ({ id, name, status })), complete };
}

export async function loadSkillSources(accessToken: string): Promise<SkillSources> {
  const { complete, items } = await collectPagesUpTo(
    (cursor) =>
      platformCallRoute(
        "listManagedSkillSources",
        { query: { cursor, limit: API_PAGE_LIMIT } },
        accessToken,
      ),
    MAX_PAGES,
  );
  return {
    complete,
    sources: items
      .map(sourceSummary)
      .toSorted((left, right) => left.name.localeCompare(right.name)),
  };
}

export async function loadSourceCatalog(
  accessToken: string,
  sourceId: string,
  callRoute: CallRoute = platformCallRoute,
): Promise<SourceCatalog> {
  const [source, releases] = await Promise.all([
    readSource(callRoute, accessToken, sourceId),
    listReleases(callRoute, accessToken, sourceId),
  ]);
  return { ...releases, source };
}

export async function loadReleaseCatalog(
  accessToken: string,
  releaseId: string,
): Promise<ReleaseCatalog> {
  const release = releaseSummary(
    await platformCallRoute("getManagedSkillRelease", { path: { id: releaseId } }, accessToken),
  );
  const [source, skills] = await Promise.all([
    readSource(platformCallRoute, accessToken, release.sourceId),
    collectPagesUpTo(
      (cursor) =>
        platformCallRoute(
          "listManagedSkills",
          { path: { id: releaseId }, query: { cursor, limit: API_PAGE_LIMIT } },
          accessToken,
        ),
      MAX_PAGES,
    ),
  ]);
  return {
    complete: skills.complete,
    release,
    skills: skills.items
      .map(skillSummary)
      .toSorted((left, right) => left.key.localeCompare(right.key)),
    source,
  };
}

export async function loadSkillContent(
  accessToken: string,
  skillId: string,
): Promise<SkillContent> {
  const { content, id, key, referencePaths } = await platformCallRoute(
    "getManagedSkill",
    { path: { id: skillId } },
    accessToken,
  );
  return { content, id, key, referencePaths };
}
