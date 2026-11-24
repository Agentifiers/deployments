import type { TransactionOperation } from "../client-types.ts";
import { createWithClaims } from "../identity-federation/operations.ts";
import type { Ulid } from "../ids.ts";
import { bffFenceRecord, principalRecord, securityStateRecord } from "./record-builders.ts";
import { makeIdentitySecurityEventRecord } from "./security-events.ts";

export interface NewHumanPrincipal {
  readonly createdAt: string;
  readonly displayName?: string;
  readonly eventId: Ulid;
  /** `verified` records the mailbox as proven at `createdAt`. */
  readonly mailbox: "verified" | "unverified";
  readonly primaryEmail: string;
  readonly principalId: Ulid;
}

/**
 * The principal with its email claim, its security state and BFF fence at session epoch 0, and the
 * `identity.principal-created` event. Organization membership is the caller's.
 */
export function newHumanPrincipalOperations(input: NewHumanPrincipal): TransactionOperation[] {
  const { createdAt, principalId } = input;
  return [
    ...createWithClaims(
      principalRecord({
        createdAt,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        id: principalId,
        primaryEmail: input.primaryEmail,
      }),
      createdAt,
    ),
    {
      kind: "put",
      record: securityStateRecord({
        createdAt,
        credentialVersion: 0,
        ...(input.mailbox === "verified" ? { emailVerifiedAt: createdAt } : {}),
        principalId,
        sessionEpoch: 0,
        version: 1,
      }),
    },
    {
      kind: "put",
      record: bffFenceRecord({
        createdAt,
        principalId,
        principalStatus: "active",
        sessionEpoch: 0,
        version: 1,
      }),
    },
    {
      kind: "put",
      record: makeIdentitySecurityEventRecord({
        aggregateId: principalId,
        aggregateType: "principal",
        aggregateVersion: 1,
        eventId: input.eventId,
        eventType: "identity.principal-created",
        occurredAt: createdAt,
        principalId,
      }),
    },
  ];
}
