import { PersistenceError, type PersistenceInvocation } from "./persistence-types.ts";

const MUTATION_OPERATION =
  /^(?:add|archive|create|install|publish|remove|revoke|rotate|stop|update)/u;
const GLOBAL_MANAGED_SKILL_MUTATION =
  /^(?:archive|create|publish|update)ManagedSkill(?:Release|Source)$/u;

/** Mirrors the API's rule: API keys never act as platform administrators. */
export function isPlatformAdministrator(invocation: PersistenceInvocation) {
  return (
    invocation.identity.authentication !== "api-credential" &&
    (invocation.identity.platformRole === "administrator" ||
      invocation.identity.scopes?.includes("platform:*") === true ||
      invocation.identity.scopes?.includes("platform:admin") === true)
  );
}

/** A platform administrator admitted to `organizationId` under open operator access. */
export function actsUnderOperatorAccess(invocation: PersistenceInvocation, organizationId: string) {
  return (
    isPlatformAdministrator(invocation) &&
    invocation.identity.operatorAccess?.organizationId === organizationId
  );
}

/**
 * The audit actor for a person's request: the principal, marked with the operator access grant
 * when a platform administrator acted under one.
 */
export function principalAuditActor<Id extends string>(
  principalId: Id,
  operatorAccessGrantId?: Id,
) {
  return {
    id: principalId,
    ...(operatorAccessGrantId ? { operatorAccessGrantId } : {}),
    type: "principal" as const,
  };
}

/**
 * Operator access lets an administrator act in an organization for a while; it must never turn
 * into a membership they keep after the access ends.
 */
export function operatorAccessSelfMembershipError() {
  return new PersistenceError(
    "forbidden",
    "operator_access_self_membership",
    "A platform administrator cannot make themselves a member of an organization through operator access. Ask an organization owner to invite you.",
  );
}

export function isMutationOperation(operationName: string) {
  return MUTATION_OPERATION.test(operationName);
}

export function isGlobalManagedSkillMutation(operationName: string) {
  return GLOBAL_MANAGED_SKILL_MUTATION.test(operationName);
}
