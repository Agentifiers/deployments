import type { Ulid } from "../ids.ts";
import {
  OPERATOR_ACCESS_DEFAULT_MINUTES,
  OPERATOR_ACCESS_MAXIMUM_MINUTES,
  type OrganizationOperatorAccess,
} from "../records/operator-access.ts";

/** What a stored grant means at `now`. Only `open` lets an administrator read tenant data. */
export type OperatorAccessStatus = "closed" | "expired" | "open";

export function operatorAccessStatus(
  access: OrganizationOperatorAccess,
  now: Date,
): OperatorAccessStatus {
  if (access.state.kind === "closed") return "closed";
  return Date.parse(access.expiresAt) > now.getTime() ? "open" : "expired";
}

/**
 * The grant that admits `principalId` to `organizationId` at `now`, if any. A record for another
 * organization or principal never admits, whatever its state.
 */
export function admittingOperatorAccess(
  access: OrganizationOperatorAccess | undefined,
  request: { readonly now: Date; readonly organizationId: Ulid; readonly principalId: Ulid },
): OrganizationOperatorAccess | undefined {
  return access !== undefined &&
    access.organizationId === request.organizationId &&
    access.principalId === request.principalId &&
    operatorAccessStatus(access, request.now) === "open"
    ? access
    : undefined;
}

export class OperatorAccessDurationError extends Error {
  constructor() {
    super(`durationMinutes must be an integer from 1 through ${OPERATOR_ACCESS_MAXIMUM_MINUTES}.`);
  }
}

export function operatorAccessExpiry(now: Date, durationMinutes: number | undefined) {
  const minutes = durationMinutes ?? OPERATOR_ACCESS_DEFAULT_MINUTES;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > OPERATOR_ACCESS_MAXIMUM_MINUTES) {
    throw new OperatorAccessDurationError();
  }
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

export interface OpenOperatorAccessCommand {
  readonly durationMinutes?: number;
  readonly grantId: Ulid;
  readonly organizationId: Ulid;
  readonly principalId: Ulid;
  readonly reason: string;
  readonly ticket?: string;
}

/**
 * The next stored grant for an open request. An open grant is renewed in place (same grant,
 * new expiry); a closed or expired one, or none, gives way to a new grant.
 */
export function openOperatorAccess(
  previous: OrganizationOperatorAccess | undefined,
  command: OpenOperatorAccessCommand,
  now: Date,
): { readonly kind: "opened" | "renewed"; readonly next: OrganizationOperatorAccess } {
  const at = now.toISOString();
  const expiresAt = operatorAccessExpiry(now, command.durationMinutes);
  const renewing = previous !== undefined && operatorAccessStatus(previous, now) === "open";
  return {
    kind: renewing ? "renewed" : "opened",
    next: {
      createdAt: previous?.createdAt ?? at,
      expiresAt,
      grantId: renewing ? previous.grantId : command.grantId,
      openedAt: renewing ? previous.openedAt : at,
      organizationId: command.organizationId,
      principalId: command.principalId,
      reason: command.reason,
      state: { kind: "open" },
      ...(command.ticket === undefined ? {} : { ticket: command.ticket }),
      updatedAt: at,
      version: (previous?.version ?? 0) + 1,
    },
  };
}

/** The closed grant, or `undefined` when nothing is open to close. */
export function closeOperatorAccess(
  previous: OrganizationOperatorAccess | undefined,
  now: Date,
): OrganizationOperatorAccess | undefined {
  if (previous === undefined || operatorAccessStatus(previous, now) !== "open") return undefined;
  const at = now.toISOString();
  return {
    ...previous,
    state: { closedAt: at, kind: "closed" },
    updatedAt: at,
    version: previous.version + 1,
  };
}
