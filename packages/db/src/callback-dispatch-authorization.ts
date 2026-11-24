import type { TransactionConditionCheck } from "./client-types.ts";
import type { PlatformRecord } from "./records/index.ts";
import { grantCoversWorkspace } from "./records/provider-connections.ts";
import type { CallbackDispatchEvidenceRecordValue } from "./records/runtime-callbacks.ts";

type CallbackDispatchEvidenceInput = CallbackDispatchEvidenceRecordValue["data"];

/**
 * The record a run executes under: a customer run's agent deployment, or a preview/evaluation
 * run's execution binding. Its frozen runtime config names the tool's workspace authorization.
 */
export type CallbackDispatchExecutionTarget = Extract<
  PlatformRecord,
  { readonly itemType: "agent-deployment" | "execution-binding" }
>;

export interface CallbackDispatchControlAuthorizationSnapshot {
  readonly connection: Extract<PlatformRecord, { readonly itemType: "provider-connection" }>;
  readonly executionTarget: CallbackDispatchExecutionTarget;
  /** Resolved from the grant provider's code definition when the binding was read. */
  readonly providerUsesNoCredential: boolean;
  readonly toolAdapter: Extract<PlatformRecord, { readonly itemType: "tool-adapter" }>;
  readonly toolCredential: Extract<PlatformRecord, { readonly itemType: "credential-vault-entry" }>;
  readonly toolPolicy?: Extract<PlatformRecord, { readonly itemType: "tool-policy" }>;
  readonly workspaceAuthorization: Extract<
    PlatformRecord,
    { readonly itemType: "workspace-connection-authorization" }
  >;
}

export class CallbackDispatchControlAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CallbackDispatchControlAuthorizationError";
  }
}

function invalid(message: string): never {
  throw new CallbackDispatchControlAuthorizationError(message);
}

type CallbackDispatchControlRecord = NonNullable<
  CallbackDispatchControlAuthorizationSnapshot[Exclude<
    keyof CallbackDispatchControlAuthorizationSnapshot,
    "providerUsesNoCredential"
  >]
>;

function matchesEvidenceScope(
  record: CallbackDispatchControlRecord,
  input: CallbackDispatchEvidenceInput,
) {
  return (
    record.data.organizationId === input.organizationId &&
    record.data.projectId === input.projectId &&
    record.data.environmentId === input.environmentId
  );
}

function matchesExecutionTarget(
  input: CallbackDispatchEvidenceInput,
  target: CallbackDispatchExecutionTarget,
  observedAt: number,
) {
  if (!matchesEvidenceScope(target, input)) return false;
  if (target.itemType === "agent-deployment") {
    return (
      target.data.id === input.agentDeploymentId &&
      target.data.agentDefinitionId === input.agentDefinitionId &&
      target.data.currentState === "ready" &&
      target.data.desiredState === "running"
    );
  }
  const source = target.data.source;
  return (
    target.data.id === input.executionBindingId &&
    target.data.purpose === input.executionPurpose &&
    target.data.status === "active" &&
    Date.parse(target.data.expiresAt) > observedAt &&
    input.agentDefinitionId ===
      (source.type === "release" ? source.agentDefinitionId : undefined) &&
    input.agentReleaseId === (source.type === "release" ? source.agentReleaseId : undefined)
  );
}

function assertControlSnapshot(
  input: CallbackDispatchEvidenceInput,
  control: CallbackDispatchControlAuthorizationSnapshot,
  observedAt: number,
) {
  const target = control.executionTarget;
  const authorization = control.workspaceAuthorization;
  const connection = control.connection;
  const adapter = control.toolAdapter;
  const credential = control.toolCredential;
  const policy = control.toolPolicy;
  const binding = target.data.runtimeConfig?.toolAuthorizations?.[input.toolName];
  const connectionAuthMethod = connection.data.authMethod.trim().toLowerCase();
  const legacyOAuthConnection =
    !connection.data.externalAccountId &&
    (connectionAuthMethod === "oauth" || connectionAuthMethod === "oauth2");

  if (
    !matchesExecutionTarget(input, target, observedAt) ||
    !binding ||
    binding.authorizationId !== authorization.data.id ||
    binding.toolPolicyId !== policy?.data.id
  ) {
    invalid(
      "Callback dispatch control snapshot does not match its active execution target binding.",
    );
  }
  const credentialReference = adapter.data.authSecretRef;
  const credentialExpiresAt = credential.data.expiresAt
    ? Date.parse(credential.data.expiresAt)
    : undefined;
  if (
    !matchesEvidenceScope(credential, input) ||
    credential.data.status !== "active" ||
    !credentialReference ||
    !("credentialId" in credentialReference) ||
    credentialReference.credentialId !== credential.data.id ||
    credentialReference.generation !== credential.data.generation ||
    credential.data.ownerType !== "tool-adapter" ||
    credential.data.ownerId !== adapter.data.id ||
    (credentialExpiresAt !== undefined &&
      (!Number.isFinite(credentialExpiresAt) || credentialExpiresAt <= observedAt))
  ) {
    invalid("Callback dispatch control snapshot does not match its active tool credential.");
  }
  if (
    !matchesEvidenceScope(authorization, input) ||
    authorization.data.status !== "active" ||
    !grantCoversWorkspace(
      authorization.data,
      input.workspaceId,
      control.providerUsesNoCredential,
    ) ||
    authorization.data.connectionId !== input.connectionId ||
    authorization.data.externalAccountId !== input.externalAccountId ||
    authorization.data.purpose !== "agent-runtime" ||
    input.requiredScopes.some((scope) => !(authorization.data.scopes ?? []).includes(scope))
  ) {
    invalid(
      "Callback dispatch control snapshot does not match its active workspace authorization.",
    );
  }
  if (
    !matchesEvidenceScope(connection, input) ||
    connection.data.id !== input.connectionId ||
    connection.data.status !== "active" ||
    connection.data.providerKey !== authorization.data.providerKey ||
    (!legacyOAuthConnection &&
      connection.data.externalAccountId !== authorization.data.externalAccountId) ||
    (authorization.data.scopes ?? []).some((scope) => !connection.data.scopes.includes(scope))
  ) {
    invalid("Callback dispatch control snapshot does not match its active provider connection.");
  }
  if (
    !input.toolAdapterId ||
    !matchesEvidenceScope(adapter, input) ||
    adapter.data.id !== input.toolAdapterId ||
    adapter.data.name !== input.toolName ||
    adapter.data.effect !== input.effect ||
    adapter.data.status !== "active" ||
    adapter.data.providerKey !== authorization.data.providerKey
  ) {
    invalid("Callback dispatch control snapshot does not match its active tool adapter.");
  }
  if (policy && (!matchesEvidenceScope(policy, input) || policy.data.status !== "active")) {
    invalid("Callback dispatch control snapshot contains an inactive tool policy.");
  }
}

function controlCondition(
  record: CallbackDispatchControlRecord,
  observedAt: string,
): TransactionConditionCheck {
  const common = {
    expressionAttributeNames: {
      "#data": "data",
      "#itemType": "itemType",
      "#version": "version",
    },
    expressionAttributeValues: {
      ":itemType": record.itemType,
      ":version": record.data.version,
    },
    key: { pk: record.pk, sk: record.sk },
    kind: "condition-check" as const,
    table: "control" as const,
  };
  if (record.itemType === "agent-deployment") {
    return {
      ...common,
      conditionExpression:
        "#itemType = :itemType AND #data.#version = :version AND #data.#currentState = :ready AND #data.#desiredState = :running",
      expressionAttributeNames: {
        ...common.expressionAttributeNames,
        "#currentState": "currentState",
        "#desiredState": "desiredState",
      },
      expressionAttributeValues: {
        ...common.expressionAttributeValues,
        ":ready": "ready",
        ":running": "running",
      },
    };
  }
  if (record.itemType === "execution-binding") {
    return {
      ...common,
      conditionExpression:
        "#itemType = :itemType AND #data.#version = :version AND #data.#status = :active AND #data.#expiresAt > :observedAt",
      expressionAttributeNames: {
        ...common.expressionAttributeNames,
        "#expiresAt": "expiresAt",
        "#status": "status",
      },
      expressionAttributeValues: {
        ...common.expressionAttributeValues,
        ":active": "active",
        ":observedAt": observedAt,
      },
    };
  }
  if (record.itemType === "credential-vault-entry") {
    const expiry = record.data.expiresAt
      ? {
          clause: "#data.#expiresAt = :expiresAt AND #data.#expiresAt > :observedAt",
          values: { ":expiresAt": record.data.expiresAt, ":observedAt": observedAt },
        }
      : { clause: "attribute_not_exists(#data.#expiresAt)", values: {} };
    return {
      ...common,
      conditionExpression: `#itemType = :itemType AND #data.#version = :version AND #data.#status = :active AND #data.#generation = :generation AND ${expiry.clause}`,
      expressionAttributeNames: {
        ...common.expressionAttributeNames,
        "#expiresAt": "expiresAt",
        "#generation": "generation",
        "#status": "status",
      },
      expressionAttributeValues: {
        ...common.expressionAttributeValues,
        ":active": "active",
        ":generation": record.data.generation,
        ...expiry.values,
      },
    };
  }
  return {
    ...common,
    conditionExpression:
      "#itemType = :itemType AND #data.#version = :version AND #data.#status = :active",
    expressionAttributeNames: { ...common.expressionAttributeNames, "#status": "status" },
    expressionAttributeValues: { ...common.expressionAttributeValues, ":active": "active" },
  };
}

export function callbackDispatchControlAuthorizationConditions(
  input: CallbackDispatchEvidenceInput,
  control: CallbackDispatchControlAuthorizationSnapshot,
  observedAt: string,
): readonly TransactionConditionCheck[] {
  assertControlSnapshot(input, control, Date.parse(observedAt));
  return [
    control.executionTarget,
    control.workspaceAuthorization,
    control.connection,
    ...(control.toolPolicy ? [control.toolPolicy] : []),
    control.toolAdapter,
    control.toolCredential,
  ].map((record) => controlCondition(record, observedAt));
}
