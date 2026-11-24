import "@tanstack/react-start/server-only";
import { PlatformApiError } from "../errors.ts";
import type { EnvironmentScope } from "../scope.ts";
import { stepIdempotencyKey, type SkillOperation } from "../skills/skill-state.ts";
import { API_PAGE_LIMIT } from "./list-pages.ts";
import { callRoute as platformCallRoute, collectPages } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

export interface SkillPlanMutation {
  readonly accessToken: string;
  readonly callRoute?: typeof platformCallRoute;
  readonly idempotencyKey: string;
  readonly operations: readonly SkillOperation[];
  readonly scope: EnvironmentScope;
}

function conflict(error: unknown, code?: string) {
  return (
    error instanceof PlatformApiError &&
    error.problem.status === 409 &&
    (code === undefined || error.problem.code === code)
  );
}

export async function applySkillPlan({
  accessToken,
  callRoute = platformCallRoute,
  idempotencyKey,
  operations,
  scope,
}: SkillPlanMutation): Promise<void> {
  const installAlreadyApplied = async (operation: Extract<SkillOperation, { kind: "install" }>) => {
    const installations = await collectPages((cursor) =>
      callRoute(
        "listManagedSkillInstallations",
        { query: { cursor, limit: API_PAGE_LIMIT }, scope },
        accessToken,
      ),
    );
    return installations.some(
      (installation) =>
        installation.status === "active" &&
        installation.managedSkillId === operation.managedSkillId &&
        installation.agentDefinitionId === operation.agentDefinitionId,
    );
  };
  const removeAlreadyApplied = async (installationId: string) => {
    const current = await callRoute(
      "getManagedSkillInstallation",
      { path: { id: installationId }, scope },
      accessToken,
    );
    return current.status !== "active";
  };

  for (const operation of operations) {
    const key = stepIdempotencyKey(idempotencyKey, operation);
    if (operation.kind === "install") {
      const { kind: _kind, ...fields } = operation;
      const body = decodeRequestBody("installManagedSkill", "InstallManagedSkillRequest", fields);
      try {
        await callRoute("installManagedSkill", { body, idempotencyKey: key, scope }, accessToken);
      } catch (error) {
        if (!conflict(error, "managed_skill_install_conflict")) throw error;
        if (!(await installAlreadyApplied(operation))) throw error;
      }
      continue;
    }
    try {
      await callRoute(
        "removeManagedSkillInstallation",
        {
          body: { expectedVersion: operation.expectedVersion },
          idempotencyKey: key,
          path: { id: operation.installationId },
          scope,
        },
        accessToken,
      );
    } catch (error) {
      if (!conflict(error)) throw error;
      if (!(await removeAlreadyApplied(operation.installationId))) throw error;
    }
  }
}
