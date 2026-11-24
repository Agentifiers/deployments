import type { AppAccessLevel, AppGrantRole, AppResponse } from "@deployments-ai/api-contract";
import type { OperationAccess } from "../access.ts";
import { memberName, type ActionState, type MemberView } from "../members/roles.ts";

export const APP_ACCESS_LEVELS = [
  "none",
  "viewer",
  "editor",
] as const satisfies readonly AppAccessLevel[];

export const APP_GRANT_ROLES = ["viewer", "editor"] as const satisfies readonly AppGrantRole[];

type AppLifecycle = AppResponse["lifecycle"];
type AppState = AppLifecycle["state"];

export const APP_WRITES = [
  "updateApp",
  "putAppGrant",
  "removeAppGrant",
  "promoteAppRelease",
  "archiveApp",
  "eraseApp",
  "setAppPublication",
  "attachAppDomain",
  "refreshAppDomain",
  "detachAppDomain",
] as const;

export type AppWrite = (typeof APP_WRITES)[number];

const ACCEPTING_STATES: { readonly [Write in AppWrite]: readonly AppState[] } = {
  archiveApp: ["active"],
  attachAppDomain: ["provisioning", "active"],
  detachAppDomain: ["provisioning", "failed", "active", "archived", "erasing"],
  eraseApp: ["failed", "active", "archived"],
  promoteAppRelease: ["active"],
  putAppGrant: ["provisioning", "active"],
  refreshAppDomain: ["provisioning", "active"],
  removeAppGrant: ["provisioning", "active"],
  setAppPublication: ["provisioning", "active"],
  updateApp: ["provisioning", "active"],
};

export type AppWrites = Partial<Readonly<Record<AppWrite, ActionState>>>;

export function appWrites(state: AppState, access: Pick<OperationAccess, AppWrite>): AppWrites {
  const writes: Partial<Record<AppWrite, ActionState>> = {};
  for (const write of APP_WRITES) {
    if (!access[write]) continue;
    writes[write] = ACCEPTING_STATES[write].includes(state)
      ? { enabled: true }
      : { enabled: false, reason: `Not available while the app is ${state}.` };
  }
  return writes;
}

export function liveReleaseId(lifecycle: AppLifecycle): string | null {
  switch (lifecycle.state) {
    case "active":
    case "archived":
      return lifecycle.liveReleaseId;
    case "provisioning":
    case "failed":
    case "erasing":
      return null;
    default: {
      const unhandled: never = lifecycle;
      return unhandled;
    }
  }
}

export interface GrantRow {
  readonly memberActive: boolean;
  readonly name: string;
  readonly principalId: string;
  readonly role: AppGrantRole;
  readonly updatedAt: string;
}

export interface MemberOption {
  readonly name: string;
  readonly principalId: string;
}

export interface GrantDirectory {
  readonly candidates: readonly MemberOption[];
  readonly grants: readonly GrantRow[];
}

export function grantDirectory(
  grants: readonly {
    readonly principalId: string;
    readonly role: AppGrantRole;
    readonly updatedAt: string;
  }[],
  members: readonly {
    readonly displayName?: string | undefined;
    readonly primaryEmail?: string | undefined;
    readonly principalId: string;
    readonly status: MemberView["status"];
  }[],
): GrantDirectory {
  const memberById = new Map(members.map((member) => [member.principalId, member]));
  const granted = new Set(grants.map((grant) => grant.principalId));
  return {
    candidates: members
      .filter((member) => member.status === "active" && !granted.has(member.principalId))
      .map((member) => ({ name: memberName(member), principalId: member.principalId }))
      .toSorted((left, right) => left.name.localeCompare(right.name)),
    grants: grants
      .map(({ principalId, role, updatedAt }) => {
        const member = memberById.get(principalId);
        return {
          memberActive: member?.status === "active",
          name: memberName(member ?? { principalId }),
          principalId,
          role,
          updatedAt,
        };
      })
      .toSorted((left, right) => left.name.localeCompare(right.name)),
  };
}
