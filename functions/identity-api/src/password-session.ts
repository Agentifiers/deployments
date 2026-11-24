import {
  makeIdentitySecurityEventRecord,
  sessionRecords,
  type IdentityRecord,
  type PasswordSecondFactor,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { randomToken, sha256, type RandomSource } from "@deployments-ai/identity";
import { plusSeconds } from "./time-arithmetic.ts";

export interface PasswordSignInMaterial {
  readonly credential: IdentityRecord<"principal-credential">;
  readonly principal: IdentityRecord<"principal">;
  readonly securityState: IdentityRecord<"principal-security-state">;
}

export interface PasswordSessionPolicy {
  readonly sessionAbsoluteLifetimeSeconds: number;
  readonly sessionIdleLifetimeSeconds: number;
}

export interface PasswordSession {
  readonly expiresAt: string;
  readonly principalId: Ulid;
  readonly sessionId: Ulid;
  readonly sessionToken: string;
}

function activeVersionCheck(
  record: IdentityRecord<"principal"> | IdentityRecord<"principal-credential">,
  table: "control" | "identity",
): TransactionOperation {
  return {
    conditionExpression: "#data.#version = :version AND #data.#status = :active",
    expressionAttributeNames: { "#data": "data", "#status": "status", "#version": "version" },
    expressionAttributeValues: { ":active": "active", ":version": record.data.version },
    key: { pk: record.pk, sk: record.sk },
    kind: "condition-check",
    table,
  };
}

/**
 * Pins the principal, credential, and security state a password check observed, rehashing the
 * credential when its profile is outdated. A step that admits the person (a session, or an MFA
 * challenge) commits only while none of them changed.
 */
export function passwordMaterialOperations(input: {
  readonly material: PasswordSignInMaterial;
  readonly replacementHash?: string;
  readonly updatedAt: string;
}): TransactionOperation[] {
  const { credential, principal, securityState } = input.material;
  return [
    activeVersionCheck(principal, "control"),
    {
      conditionExpression:
        "#data.#version = :version AND #data.#credentialVersion = :credentialVersion AND #data.#sessionEpoch = :sessionEpoch",
      expressionAttributeNames: {
        "#credentialVersion": "credentialVersion",
        "#data": "data",
        "#sessionEpoch": "sessionEpoch",
        "#version": "version",
      },
      expressionAttributeValues: {
        ":credentialVersion": securityState.data.credentialVersion,
        ":sessionEpoch": securityState.data.sessionEpoch,
        ":version": securityState.data.version,
      },
      key: { pk: securityState.pk, sk: securityState.sk },
      kind: "condition-check",
      table: "identity",
    },
    input.replacementHash
      ? {
          kind: "put",
          previousRecord: credential,
          record: {
            ...credential,
            data: {
              ...credential.data,
              passwordHash: input.replacementHash,
              updatedAt: input.updatedAt,
              version: credential.data.version + 1,
            },
          },
        }
      : activeVersionCheck(credential, "identity"),
  ];
}

/**
 * The browser session a completed password sign-in creates, and the operations that commit it.
 * A successful sign-in also clears the failed-attempt telemetry on the security state.
 */
export function passwordSessionOperations(input: {
  readonly generateId: () => Ulid;
  readonly ipPrefixHash?: string;
  readonly material: PasswordSignInMaterial;
  readonly policy: PasswordSessionPolicy;
  readonly random: RandomSource;
  readonly replacementHash?: string;
  readonly secondFactor?: PasswordSecondFactor;
  readonly timestamp: Date;
  readonly deviceLabel?: string;
  readonly userAgentHash?: string;
}): { readonly operations: TransactionOperation[]; readonly session: PasswordSession } {
  const { material, timestamp } = input;
  const principalId = material.principal.data.id;
  const createdAt = timestamp.toISOString();
  const sessionId = input.generateId();
  const sessionToken = randomToken(input.random);
  const records = sessionRecords({
    authentication: {
      method: "password",
      ...(input.secondFactor ? { secondFactor: input.secondFactor } : {}),
    },
    authenticationTime: createdAt,
    createdAt,
    expiresAt: plusSeconds(timestamp, input.policy.sessionAbsoluteLifetimeSeconds),
    id: sessionId,
    idleExpiresAt: plusSeconds(timestamp, input.policy.sessionIdleLifetimeSeconds),
    ...(input.ipPrefixHash ? { ipPrefixHash: input.ipPrefixHash } : {}),
    principalId,
    sessionEpoch: material.securityState.data.sessionEpoch,
    tokenHash: sha256(sessionToken),
    ...(input.deviceLabel ? { deviceLabel: input.deviceLabel } : {}),
    ...(input.userAgentHash ? { userAgentHash: input.userAgentHash } : {}),
  });
  const event = (aggregate: {
    readonly aggregateId: Ulid;
    readonly aggregateType: string;
    readonly aggregateVersion: number;
    readonly eventType: string;
  }): TransactionOperation => ({
    kind: "put",
    record: makeIdentitySecurityEventRecord({
      ...aggregate,
      eventId: input.generateId(),
      occurredAt: createdAt,
      principalId,
    }),
  });
  const materialOperations = passwordMaterialOperations({
    material,
    ...(input.replacementHash ? { replacementHash: input.replacementHash } : {}),
    updatedAt: createdAt,
  });
  const {
    authenticationFailedAt: _authenticationFailedAt,
    authenticationFailureCount: _authenticationFailureCount,
    ...securityData
  } = material.securityState.data;
  const hasThrottleState =
    material.securityState.data.authenticationFailedAt !== undefined ||
    material.securityState.data.authenticationFailureCount !== undefined;
  const securityOperations: TransactionOperation[] = hasThrottleState
    ? [
        {
          kind: "put",
          previousRecord: material.securityState,
          record: {
            ...material.securityState,
            data: {
              ...securityData,
              updatedAt: createdAt,
              version: material.securityState.data.version + 1,
            },
          },
        },
        event({
          aggregateId: principalId,
          aggregateType: "principal-security-state",
          aggregateVersion: material.securityState.data.version + 1,
          eventType: "identity.sign-in-throttle-cleared",
        }),
      ]
    : [materialOperations[1]!];
  return {
    operations: [
      materialOperations[0]!,
      { kind: "put", record: records.session },
      { kind: "put", record: records.locator },
      ...securityOperations,
      materialOperations[2]!,
      event({
        aggregateId: sessionId,
        aggregateType: "identity-session",
        aggregateVersion: 1,
        eventType: "identity.session-created",
      }),
    ],
    session: {
      expiresAt: records.session.data.expiresAt,
      principalId,
      sessionId,
      sessionToken,
    },
  };
}
