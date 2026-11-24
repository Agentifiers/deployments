import { TENANCY_PATHS } from "@deployments-ai/api-contract/routes";
import type { CommandCatalog } from "./types.ts";
import {
  action,
  create,
  id,
  json,
  list,
  mutate,
  requiredNumber,
  requiredText,
  show,
  text,
} from "./catalog-helpers.ts";

export const expectedVersion = {
  ...requiredNumber("Expected resource version"),
  field: "expectedVersion",
};

export const agentReleaseId = {
  ...requiredText("Agent release ID"),
  field: "agentReleaseId",
};

export const tenancyPagination = {
  limitField: "limit",
  maxLimit: 100,
  target: "query",
} as const;

const deploymentPath = `${TENANCY_PATHS.agentDeployments}/:id`;

export const agentDeploymentCommandCatalog: CommandCatalog = {
  release: {
    summary: "Immutable agent releases",
    actions: {
      list: action({
        summary: "List releases for an agent definition",
        method: "GET",
        path: `${TENANCY_PATHS.agentDefinitions}/:id/releases`,
        scope: "environment",
        output: "list",
        args: { id },
        pagination: tenancyPagination,
      }),
      show: show(TENANCY_PATHS.agentReleases, "environment", "Show an agent release"),
      archive: mutate(
        "DELETE",
        TENANCY_PATHS.agentReleases,
        "environment",
        "Archive an agent release",
        { id, "expected-version": expectedVersion },
      ),
      promote: action({
        summary: "Promote an agent release into another environment",
        method: "POST",
        path: `${TENANCY_PATHS.agentReleases}/:id/promote`,
        scope: "environment",
        output: "detail",
        args: {
          id,
          "target-environment": {
            ...requiredText("Target environment ID"),
            field: "targetEnvironmentId",
          },
        },
        idempotent: true,
      }),
    },
  },
  deployment: {
    summary: "Environment agent deployments",
    actions: {
      create: create(
        TENANCY_PATHS.agentDeployments,
        "environment",
        {
          release: agentReleaseId,
          "desired-state": text("running or paused"),
          "runtime-config": json("Deployment runtime configuration"),
        },
        "Create an agent deployment",
      ),
      list: list(
        TENANCY_PATHS.agentDeployments,
        "environment",
        "List agent deployments",
        tenancyPagination,
      ),
      show: show(TENANCY_PATHS.agentDeployments, "environment", "Show an agent deployment"),
      pause: action({
        summary: "Pause an agent deployment",
        method: "PATCH",
        path: deploymentPath,
        scope: "environment",
        output: "action",
        args: { id, "expected-version": expectedVersion },
        fixedBody: { desiredState: "paused" },
        idempotent: true,
      }),
      resume: action({
        summary: "Resume an agent deployment",
        method: "PATCH",
        path: deploymentPath,
        scope: "environment",
        output: "action",
        args: { id, "expected-version": expectedVersion },
        fixedBody: { desiredState: "running" },
        idempotent: true,
      }),
      update: mutate(
        "PATCH",
        TENANCY_PATHS.agentDeployments,
        "environment",
        "Update an agent deployment",
        {
          id,
          "expected-version": expectedVersion,
          "runtime-config": json("Deployment runtime configuration"),
          release: { ...text("Retarget to this agent release ID"), field: "agentReleaseId" },
        },
      ),
      rollback: action({
        summary: "Roll an agent deployment back to an earlier release",
        method: "PATCH",
        path: deploymentPath,
        scope: "environment",
        output: "detail",
        args: {
          id,
          to: { ...requiredText("Agent release ID to roll back to"), field: "agentReleaseId" },
          "expected-version": expectedVersion,
        },
        idempotent: true,
      }),
      "canary-start": action({
        summary: "Start a canary for a candidate agent release",
        method: "POST",
        path: `${deploymentPath}/canary`,
        scope: "environment",
        output: "detail",
        args: {
          id,
          release: {
            ...requiredText("Candidate agent release ID"),
            field: "candidateAgentReleaseId",
          },
          weight: { ...requiredNumber("Candidate traffic percentage (1-99)"), field: "weight" },
          "expected-version": expectedVersion,
        },
        idempotent: true,
      }),
      "canary-promote": action({
        summary: "Promote the canary candidate to primary",
        method: "POST",
        path: `${deploymentPath}/canary/promote`,
        scope: "environment",
        output: "detail",
        args: { id, "expected-version": expectedVersion },
        idempotent: true,
      }),
      "canary-abort": action({
        summary: "Abort the active canary",
        method: "POST",
        path: `${deploymentPath}/canary/abort`,
        scope: "environment",
        output: "detail",
        args: { id, "expected-version": expectedVersion },
        idempotent: true,
      }),
      stop: mutate(
        "DELETE",
        TENANCY_PATHS.agentDeployments,
        "environment",
        "Stop an agent deployment",
        { id, "expected-version": expectedVersion },
      ),
    },
  },
};
