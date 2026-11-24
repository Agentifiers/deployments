import { TENANCY_PATHS } from "@deployments-ai/api-contract/routes";
import type { CommandCatalog } from "./types.ts";
import {
  action,
  create,
  id,
  json,
  list,
  mutate,
  nullFlag,
  requiredJson,
  requiredNumber,
  requiredText,
  show,
  text,
} from "./catalog-helpers.ts";

const pagination = { limitField: "limit", maxLimit: 100, target: "query" } as const;
const expectedVersion = {
  ...requiredNumber("Expected resource version"),
  field: "expectedVersion",
};

export const controlResourceCommandCatalog: CommandCatalog = {
  workflow: {
    summary: "Versioned deterministic workflow definitions",
    actions: {
      list: list(
        TENANCY_PATHS.workflowDefinitions,
        "environment",
        "List workflow definitions",
        pagination,
      ),
      create: create(
        TENANCY_PATHS.workflowDefinitions,
        "environment",
        { definition: requiredJson("Workflow definition document") },
        "Create a workflow definition",
      ),
      show: show(TENANCY_PATHS.workflowDefinitions, "environment", "Show a workflow definition"),
      update: mutate(
        "PATCH",
        TENANCY_PATHS.workflowDefinitions,
        "environment",
        "Update a workflow definition",
        {
          id,
          definition: requiredJson("Workflow definition document"),
          "expected-version": expectedVersion,
        },
      ),
      archive: mutate(
        "DELETE",
        TENANCY_PATHS.workflowDefinitions,
        "environment",
        "Archive a workflow definition",
        { id, "expected-version": expectedVersion },
      ),
      release: action({
        summary: "Publish an immutable workflow release",
        method: "POST",
        path: `${TENANCY_PATHS.workflowDefinitions}/:id/releases`,
        scope: "environment",
        output: "detail",
        args: {
          id,
          "expected-definition-version": {
            ...requiredNumber("Expected workflow definition version"),
            field: "expectedDefinitionVersion",
          },
        },
        idempotent: true,
      }),
    },
  },
  "workflow-release": {
    summary: "Immutable workflow releases",
    actions: {
      list: action({
        summary: "List releases for a workflow definition",
        method: "GET",
        path: `${TENANCY_PATHS.workflowDefinitions}/:id/releases`,
        scope: "environment",
        output: "list",
        args: { id },
        pagination,
      }),
      show: show(TENANCY_PATHS.workflowReleases, "environment", "Show a workflow release"),
      archive: mutate(
        "DELETE",
        TENANCY_PATHS.workflowReleases,
        "environment",
        "Archive a workflow release",
        { id, "expected-version": expectedVersion },
      ),
    },
  },
  "managed-skill-source": {
    summary: "Managed skill catalog sources",
    actions: {
      list: list(
        TENANCY_PATHS.managedSkillSources,
        "none",
        "List managed skill sources",
        pagination,
      ),
      create: create(
        TENANCY_PATHS.managedSkillSources,
        "none",
        {
          key: requiredText("Stable source key"),
          name: requiredText("Source name"),
          "repository-url": { ...text("HTTPS repository URL"), field: "repositoryUrl" },
          "pinned-commit": { ...text("Pinned commit"), field: "pinnedCommit" },
          "license-hash": { ...text("Canonical license hash"), field: "licenseHash" },
          metadata: json("Source metadata"),
        },
        "Create a managed skill source",
      ),
      show: show(TENANCY_PATHS.managedSkillSources, "none", "Show a managed skill source"),
      update: mutate(
        "PATCH",
        TENANCY_PATHS.managedSkillSources,
        "none",
        "Update a managed skill source",
        {
          id,
          "clear-license-hash": nullFlag("Clear the canonical license hash", "licenseHash"),
          "clear-metadata": nullFlag("Clear source metadata", "metadata"),
          "clear-pinned-commit": nullFlag("Clear the pinned commit", "pinnedCommit"),
          "clear-repository-url": nullFlag("Clear the repository URL", "repositoryUrl"),
          "expected-version": expectedVersion,
          name: text("Source name"),
          "repository-url": { ...text("HTTPS repository URL"), field: "repositoryUrl" },
          "pinned-commit": { ...text("Pinned commit"), field: "pinnedCommit" },
          "license-hash": { ...text("Canonical license hash"), field: "licenseHash" },
          metadata: json("Source metadata"),
        },
      ),
      archive: mutate(
        "DELETE",
        TENANCY_PATHS.managedSkillSources,
        "none",
        "Archive a managed skill source",
        { id, "expected-version": expectedVersion },
      ),
    },
  },
  "managed-skill-release": {
    summary: "Immutable managed skill releases",
    actions: {
      list: action({
        summary: "List releases for a managed skill source",
        method: "GET",
        path: `${TENANCY_PATHS.managedSkillSources}/:id/releases`,
        scope: "none",
        output: "list",
        args: { id },
        pagination,
      }),
      publish: action({
        summary: "Publish materialized managed skill content",
        method: "POST",
        path: `${TENANCY_PATHS.managedSkillSources}/:id/releases`,
        scope: "none",
        output: "detail",
        idempotent: true,
        args: {
          id,
          "expected-source-version": {
            ...requiredNumber("Expected managed skill source version"),
            field: "expectedSourceVersion",
          },
          "release-version": {
            ...requiredText("Semantic release version"),
            field: "releaseVersion",
          },
          manifest: json("Release manifest"),
          skills: requiredJson("Managed skills array"),
        },
      }),
      show: show(TENANCY_PATHS.managedSkillReleases, "none", "Show a managed skill release"),
      archive: mutate(
        "DELETE",
        TENANCY_PATHS.managedSkillReleases,
        "none",
        "Archive a managed skill release",
        { id, "expected-version": expectedVersion },
      ),
      skills: action({
        summary: "Inspect skills in a managed skill release",
        method: "GET",
        path: `${TENANCY_PATHS.managedSkillReleases}/:id/skills`,
        scope: "none",
        output: "list",
        args: { id },
        pagination,
      }),
    },
  },
  "managed-skill": {
    summary: "Inspectable managed skill content",
    actions: {
      show: show(TENANCY_PATHS.managedSkills, "none", "Inspect a managed skill"),
    },
  },
  "managed-skill-installation": {
    summary: "Environment managed skill installations",
    actions: {
      list: list(
        TENANCY_PATHS.managedSkillInstallations,
        "environment",
        "List managed skill installations",
        pagination,
      ),
      install: create(
        TENANCY_PATHS.managedSkillInstallations,
        "environment",
        {
          "managed-skill-id": {
            ...requiredText("Managed skill ID"),
            field: "managedSkillId",
          },
          "managed-skill-release-id": {
            ...requiredText("Managed skill release ID"),
            field: "managedSkillReleaseId",
          },
          "agent-definition-id": {
            ...text("Optional agent definition ID"),
            field: "agentDefinitionId",
          },
        },
        "Install a managed skill",
      ),
      show: show(
        TENANCY_PATHS.managedSkillInstallations,
        "environment",
        "Show a managed skill installation",
      ),
      remove: mutate(
        "DELETE",
        TENANCY_PATHS.managedSkillInstallations,
        "environment",
        "Remove a managed skill installation",
        { id, "expected-version": expectedVersion },
      ),
    },
  },
};
