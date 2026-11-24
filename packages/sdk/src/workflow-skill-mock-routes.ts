import type {
  StoredManagedSkill,
  StoredManagedSkillInstallation,
  StoredManagedSkillRelease,
  StoredManagedSkillSource,
  StoredWorkflowDefinition,
  StoredWorkflowRelease,
  TenancyMockResult,
  TenancyMockRouteContext,
} from "./tenancy-mock.ts";
import {
  MOCK_TENANCY_FIXTURE_IDS,
  agentScope,
  assertActive,
  assertExpectedVersion,
  body,
  managedSkillSource,
  manifestContentHash,
  nextPublicId,
  page,
  requireAgentDefinition,
  requireManagedSkill,
  requireManagedSkillInstallation,
  requireManagedSkillRelease,
  requireManagedSkillSource,
  requireWorkflowDefinition,
  requireWorkflowRelease,
  workflowDefinition,
  workflowDefinitionSummary,
  workflowReleaseSummary,
} from "./tenancy-mock.ts";

export async function handleWorkflowSkillMockRoutes(
  context: TenancyMockRouteContext,
): Promise<TenancyMockResult | undefined> {
  const {
    id,
    inputRequest: _inputRequest,
    issued: _issued,
    listQuery,
    now,
    request,
    respond,
    routeName,
    state,
  } = context;
  switch (routeName) {
    case "listWorkflowDefinitions": {
      const environmentId = agentScope(request).environmentId;
      const items = [...state.workflowDefinitions.values()]
        .filter((definition) => definition.environmentId === environmentId)
        .map(workflowDefinitionSummary);
      return respond(page(items, listQuery));
    }
    case "createWorkflowDefinition": {
      const item = workflowDefinition(request, now, nextPublicId(state));
      state.workflowDefinitions.set(item.id, item);
      return respond(item);
    }
    case "getWorkflowDefinition": {
      return respond(requireWorkflowDefinition(state, request, id ?? ""));
    }
    case "updateWorkflowDefinition": {
      const definitionId = id ?? "";
      const prior = requireWorkflowDefinition(state, request, definitionId);
      assertActive(prior, "Workflow definition");
      assertExpectedVersion(prior.version, body(request).expectedVersion);
      const item = {
        ...workflowDefinition(request, now, definitionId),
        createdAt: prior.createdAt,
        version: prior.version + 1,
      } as StoredWorkflowDefinition;
      state.workflowDefinitions.set(definitionId, item);
      return respond(item);
    }
    case "archiveWorkflowDefinition": {
      const definitionId = id ?? "";
      const prior = requireWorkflowDefinition(state, request, definitionId);
      assertExpectedVersion(prior.version, body(request).expectedVersion);
      const item = {
        ...prior,
        status: "archived",
        updatedAt: now,
        version: prior.version + 1,
      } as StoredWorkflowDefinition;
      state.workflowDefinitions.set(definitionId, item);
      return respond(item);
    }
    case "listWorkflowReleases": {
      const definitionId = id ?? "";
      requireWorkflowDefinition(state, request, definitionId);
      const items = [...state.workflowReleases.values()]
        .filter((release) => release.workflowDefinitionId === definitionId)
        .map(workflowReleaseSummary);
      return respond(page(items, listQuery));
    }
    case "publishWorkflowRelease": {
      const definitionId = id ?? "";
      const definition = requireWorkflowDefinition(state, request, definitionId);
      assertActive(definition, "Workflow definition");
      assertExpectedVersion(definition.version, body(request).expectedDefinitionVersion);
      const releases = [...state.workflowReleases.values()].filter(
        (release) => release.workflowDefinitionId === definitionId,
      );
      const releaseNumber =
        Math.max(0, ...releases.map((release) => Number(release.releaseNumber))) + 1;
      const releaseId = nextPublicId(state);
      const item = {
        ...agentScope(request),
        contentHash: await manifestContentHash(definition.draft),
        createdAt: now,
        createdByPrincipalId: MOCK_TENANCY_FIXTURE_IDS.serviceAccount,
        definition: structuredClone(definition.draft),
        id: releaseId,
        releaseNumber,
        status: "active",
        version: 0,
        workflowDefinitionId: definitionId,
      } as StoredWorkflowRelease;
      state.workflowReleases.set(releaseId, item);
      state.workflowDefinitions.set(definitionId, {
        ...definition,
        updatedAt: now,
        version: definition.version + 1,
      });
      return respond(item);
    }
    case "getWorkflowRelease": {
      return respond(requireWorkflowRelease(state, request, id ?? ""));
    }
    case "archiveWorkflowRelease": {
      const releaseId = id ?? "";
      const prior = requireWorkflowRelease(state, request, releaseId);
      assertExpectedVersion(prior.version, body(request).expectedVersion);
      const item = {
        ...prior,
        status: "archived",
        version: prior.version + 1,
      } as StoredWorkflowRelease;
      state.workflowReleases.set(releaseId, item);
      return respond(item);
    }
    case "listManagedSkillSources": {
      return respond(page([...state.managedSkillSources.values()], listQuery));
    }
    case "createManagedSkillSource": {
      const item = managedSkillSource(request, now, nextPublicId(state));
      if (
        [...state.managedSkillSources.values()].some(
          (source) => source.key.toLowerCase() === item.key.toLowerCase(),
        )
      ) {
        throw new TypeError("An active managed skill source already uses this key.");
      }
      state.managedSkillSources.set(item.id, item);
      return respond(item);
    }
    case "getManagedSkillSource": {
      return respond(requireManagedSkillSource(state, id ?? ""));
    }
    case "updateManagedSkillSource": {
      const sourceId = id ?? "";
      const prior = requireManagedSkillSource(state, sourceId);
      assertActive(prior, "Managed skill source");
      const input = body(request);
      assertExpectedVersion(prior.version, input.expectedVersion);
      const clearedFields = new Set(
        ["licenseHash", "metadata", "pinnedCommit", "repositoryUrl"].filter(
          (field) => input[field] === null,
        ),
      );
      const retained = Object.fromEntries(
        Object.entries(prior).filter(([field]) => !clearedFields.has(field)),
      );
      const updates = Object.fromEntries(
        Object.entries(input).filter(
          ([field, value]) => field !== "expectedVersion" && value !== null,
        ),
      );
      const item = {
        ...retained,
        ...updates,
        updatedAt: now,
        version: prior.version + 1,
      } as unknown as StoredManagedSkillSource;
      state.managedSkillSources.set(sourceId, item);
      return respond(item);
    }
    case "archiveManagedSkillSource": {
      const sourceId = id ?? "";
      const prior = requireManagedSkillSource(state, sourceId);
      assertExpectedVersion(prior.version, body(request).expectedVersion);
      const item = {
        ...prior,
        status: "archived",
        updatedAt: now,
        version: prior.version + 1,
      } as StoredManagedSkillSource;
      state.managedSkillSources.set(sourceId, item);
      return respond(item);
    }
    case "listManagedSkillReleases": {
      const sourceId = id ?? "";
      requireManagedSkillSource(state, sourceId);
      const items = [...state.managedSkillReleases.values()].filter(
        (release) => release.sourceId === sourceId,
      );
      return respond(page(items, listQuery));
    }
    case "publishManagedSkillRelease": {
      const sourceId = id ?? "";
      const source = requireManagedSkillSource(state, sourceId);
      assertActive(source, "Managed skill source");
      const input = body(request);
      assertExpectedVersion(source.version, input.expectedSourceVersion);
      const releaseVersion = String(input.releaseVersion);
      if (
        [...state.managedSkillReleases.values()].some(
          (release) => release.sourceId === sourceId && release.releaseVersion === releaseVersion,
        )
      ) {
        throw new TypeError("Managed skill releaseVersion is already in use for this source.");
      }
      const entries = input.skills as readonly Readonly<Record<string, unknown>>[];
      const skillIds = entries.map(() => nextPublicId(state));
      const idsByKey = new Map(
        entries.map((entry, index) => [String(entry.key), skillIds[index]!] as const),
      );
      for (const entry of entries) {
        for (const dependency of (entry.dependencies ?? []) as readonly string[]) {
          if (!idsByKey.has(dependency)) {
            throw new TypeError(
              `Managed skill ${String(entry.key)} references missing dependency ${dependency}.`,
            );
          }
        }
      }
      const releaseId = nextPublicId(state);
      const releasePayload = {
        manifest: input.manifest ?? {},
        releaseVersion,
        skills: entries,
      };
      const release = {
        activatedAt: now,
        contentHash: await manifestContentHash(releasePayload),
        createdAt: now,
        id: releaseId,
        manifest: input.manifest ?? {},
        releaseVersion,
        skillCount: entries.length,
        sourceId,
        status: "active",
        version: 0,
      } as StoredManagedSkillRelease;
      const skills = entries.map(
        (entry, index): StoredManagedSkill => ({
          content: entry.content,
          createdAt: now,
          dependencies: ((entry.dependencies ?? []) as readonly string[]).map(
            (dependency) => idsByKey.get(dependency)!,
          ),
          ...(entry.description ? { description: entry.description } : {}),
          id: skillIds[index]!,
          key: entry.key,
          ...(entry.metadata ? { metadata: entry.metadata } : {}),
          referencePaths: Object.keys(
            (entry.references ?? {}) as Readonly<Record<string, string>>,
          ).toSorted(),
          releaseId,
          sourceId,
        }),
      );
      state.managedSkillReleases.set(releaseId, release);
      for (const skill of skills) state.managedSkills.set(skill.id, skill);
      state.managedSkillSources.set(sourceId, {
        ...source,
        updatedAt: now,
        version: source.version + 1,
      });
      return respond(release);
    }
    case "getManagedSkillRelease": {
      return respond(requireManagedSkillRelease(state, id ?? ""));
    }
    case "archiveManagedSkillRelease": {
      const releaseId = id ?? "";
      const prior = requireManagedSkillRelease(state, releaseId);
      assertExpectedVersion(prior.version, body(request).expectedVersion);
      const item = {
        ...prior,
        archivedAt: now,
        status: "archived",
        version: prior.version + 1,
      } as StoredManagedSkillRelease;
      state.managedSkillReleases.set(releaseId, item);
      return respond(item);
    }
    case "listManagedSkills": {
      const releaseId = id ?? "";
      requireManagedSkillRelease(state, releaseId);
      const items = [...state.managedSkills.values()].filter(
        (skill) => skill.releaseId === releaseId,
      );
      return respond(page(items, listQuery));
    }
    case "getManagedSkill": {
      return respond(requireManagedSkill(state, id ?? ""));
    }
    case "listManagedSkillInstallations": {
      const environmentId = agentScope(request).environmentId;
      const items = [...state.managedSkillInstallations.values()].filter(
        (installation) => installation.environmentId === environmentId,
      );
      return respond(page(items, listQuery));
    }
    case "installManagedSkill": {
      const input = body(request);
      const releaseId = String(input.managedSkillReleaseId);
      const release = requireManagedSkillRelease(state, releaseId);
      assertActive(release, "Managed skill release");
      const skillId = String(input.managedSkillId);
      const skill = requireManagedSkill(state, skillId);
      if (skill.releaseId !== releaseId) {
        throw new TypeError("Managed skill does not belong to the requested release.");
      }
      if (input.agentDefinitionId) {
        if (typeof input.agentDefinitionId !== "string") {
          throw new TypeError("agentDefinitionId must be a string.");
        }
        const definition = requireAgentDefinition(state, request, now, input.agentDefinitionId);
        assertActive(definition, "Agent definition");
      }
      const installScope = agentScope(request);
      const duplicate = [...state.managedSkillInstallations.values()].some(
        (installation) =>
          installation.status === "active" &&
          installation.environmentId === installScope.environmentId &&
          installation.managedSkillId === skillId &&
          installation.agentDefinitionId === input.agentDefinitionId,
      );
      if (duplicate) {
        throw new TypeError("Managed skill is already installed for the requested target.");
      }
      const item = {
        ...installScope,
        ...(input.agentDefinitionId ? { agentDefinitionId: input.agentDefinitionId } : {}),
        createdAt: now,
        id: nextPublicId(state),
        installedByPrincipalId: MOCK_TENANCY_FIXTURE_IDS.serviceAccount,
        managedSkillId: skillId,
        managedSkillReleaseId: releaseId,
        status: "active",
        updatedAt: now,
        version: 0,
      } as StoredManagedSkillInstallation;
      state.managedSkillInstallations.set(item.id, item);
      return respond(item);
    }
    case "getManagedSkillInstallation": {
      return respond(requireManagedSkillInstallation(state, request, id ?? ""));
    }
    case "removeManagedSkillInstallation": {
      const installationId = id ?? "";
      const prior = requireManagedSkillInstallation(state, request, installationId);
      assertExpectedVersion(prior.version, body(request).expectedVersion);
      assertActive(prior, "Managed skill installation");
      const item = {
        ...prior,
        status: "removed",
        updatedAt: now,
        version: prior.version + 1,
      } as StoredManagedSkillInstallation;
      state.managedSkillInstallations.set(installationId, item);
      return respond(item);
    }
    default:
      return undefined;
  }
}
