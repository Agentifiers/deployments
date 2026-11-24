import { describe, expect, test } from "bun:test";
import { PlatformApiError } from "../errors.ts";
import { applySkillPlan } from "./managed-skill-actions.ts";
import type { callRoute } from "./platform-api.ts";

const SCOPE = {
  environmentId: "01M4CGZTV7TVHABD2TD30NADP2",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G600C",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G600D",
};
const SKILL = "01M4CK1HAK2KWR62793BEC7ZGZ";
const RELEASE = "01M4CK1HAK2KWR62793BEC7ZH0";
const AGENT = "01M4CK1GWJARA9NEF7WAEV8QA1";
const OLD = "01M4CK1GWJARA9NEF7WAEV8QB1";

type Responses = Readonly<Record<string, (input: unknown) => unknown>>;

function platform(responses: Responses) {
  const calls: string[] = [];
  const fake = async (name: string, input: object) => {
    calls.push("idempotencyKey" in input ? `${name} ${String(input.idempotencyKey)}` : name);
    const respond = responses[name];
    if (!respond) throw new Error(`unexpected ${name}`);
    return respond(input);
  };
  const call = fake as unknown as typeof callRoute;
  return { call, calls };
}

function problem(operation: string, code: string, status = 409) {
  return new PlatformApiError(operation, { code, status, title: code });
}

function installation(status: string, agentDefinitionId?: string) {
  return {
    ...(agentDefinitionId === undefined ? {} : { agentDefinitionId }),
    id: OLD,
    managedSkillId: SKILL,
    status,
  };
}

const UPGRADE = [
  {
    agentDefinitionId: AGENT,
    kind: "install",
    managedSkillId: SKILL,
    managedSkillReleaseId: RELEASE,
  },
  { expectedVersion: 2, installationId: OLD, kind: "remove" },
] as const;

describe("applySkillPlan", () => {
  test("runs each step in order under its derived key", async () => {
    const { call, calls } = platform({
      installManagedSkill: () => ({}),
      removeManagedSkillInstallation: () => ({}),
    });
    await applySkillPlan({
      accessToken: "token",
      callRoute: call,
      idempotencyKey: "dialog",
      operations: UPGRADE,
      scope: SCOPE,
    });
    expect(calls).toEqual([
      `installManagedSkill dialog:install:${SKILL}`,
      `removeManagedSkillInstallation dialog:remove:${OLD}`,
    ]);
  });

  test("a replayed plan treats an install conflict as done when the skill is active for the target", async () => {
    const { call, calls } = platform({
      getManagedSkillInstallation: () => installation("removed"),
      installManagedSkill: () => {
        throw problem("installManagedSkill", "managed_skill_install_conflict");
      },
      listManagedSkillInstallations: () => ({ items: [installation("active", AGENT)] }),
      removeManagedSkillInstallation: () => {
        throw problem("removeManagedSkillInstallation", "version_conflict");
      },
    });
    await applySkillPlan({
      accessToken: "token",
      callRoute: call,
      idempotencyKey: "retry",
      operations: UPGRADE,
      scope: SCOPE,
    });
    expect(calls).toEqual([
      `installManagedSkill retry:install:${SKILL}`,
      "listManagedSkillInstallations",
      `removeManagedSkillInstallation retry:remove:${OLD}`,
      "getManagedSkillInstallation",
    ]);
  });

  test("an install conflict for a skill active only for another target stops the plan", async () => {
    const { call, calls } = platform({
      installManagedSkill: () => {
        throw problem("installManagedSkill", "managed_skill_install_conflict");
      },
      listManagedSkillInstallations: () => ({ items: [installation("active")] }),
    });
    const failure = await applySkillPlan({
      accessToken: "token",
      callRoute: call,
      idempotencyKey: "dialog",
      operations: UPGRADE,
      scope: SCOPE,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ problem: { code: "managed_skill_install_conflict" } });
    expect(calls).toEqual([
      `installManagedSkill dialog:install:${SKILL}`,
      "listManagedSkillInstallations",
    ]);
  });

  test("a remove conflict on a still-active installation fails", async () => {
    const { call } = platform({
      getManagedSkillInstallation: () => installation("active", AGENT),
      removeManagedSkillInstallation: () => {
        throw problem("removeManagedSkillInstallation", "version_conflict");
      },
    });
    const failure = await applySkillPlan({
      accessToken: "token",
      callRoute: call,
      idempotencyKey: "dialog",
      operations: [UPGRADE[1]],
      scope: SCOPE,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ problem: { code: "version_conflict" } });
  });

  test("a failure other than a conflict stops the plan before later steps", async () => {
    const { call, calls } = platform({
      installManagedSkill: () => {
        throw problem("installManagedSkill", "managed_skill_release_mismatch", 422);
      },
    });
    const failure = await applySkillPlan({
      accessToken: "token",
      callRoute: call,
      idempotencyKey: "dialog",
      operations: UPGRADE,
      scope: SCOPE,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ problem: { code: "managed_skill_release_mismatch" } });
    expect(calls).toEqual([`installManagedSkill dialog:install:${SKILL}`]);
  });
});
