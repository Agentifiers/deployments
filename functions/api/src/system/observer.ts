import {
  isSameRole,
  parseRoleArn,
  SYSTEM_ACCOUNT_ID_ENV,
  sessionRole,
  type IamRole,
} from "./iam-roles.ts";

export const SYSTEM_OBSERVER_ENV = {
  accountId: SYSTEM_ACCOUNT_ID_ENV,
  roleArns: "DEPLOYMENTS_AI_SYSTEM_OBSERVER_ROLE_ARNS",
} as const;

export function parseSystemObserverRoles(environment: NodeJS.ProcessEnv): readonly IamRole[] {
  const ownAccount = environment[SYSTEM_OBSERVER_ENV.accountId]?.trim();
  return (environment[SYSTEM_OBSERVER_ENV.roleArns] ?? "").split(",").flatMap((entry) => {
    const role = parseRoleArn(entry.trim());
    return role && role.account === ownAccount ? [role] : [];
  });
}

export function isSystemObserver(
  roles: readonly IamRole[],
  iamUserArn: string | undefined,
): iamUserArn is string {
  const role = sessionRole(iamUserArn);
  return role !== undefined && roles.some((observer) => isSameRole(observer, role));
}
